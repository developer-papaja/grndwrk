import { describe, expect, it, vi } from 'vitest'
import { checkStore } from '../src/shared-store/check.js'
import { HttpStore } from '../src/shared-store/http.js'
import { access } from '../stores/cloudflare/src/access.js'
import { CHUNK, type Storage, Store } from '../stores/cloudflare/src/store.js'
import worker, { type Env, limitsOf, listProjects, StoreObject } from '../stores/cloudflare/src/worker.js'
import { expectServesPage, PAGE_FILES } from './page-fixture.js'

/** A Durable Object's storage, in memory: keys listed in order, values copied as structured clone does. */
class MemoryStorage implements Storage {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)) }
  async delete(key: string) { return this.data.delete(key) }
  async list<T>({ prefix, start, limit }: { prefix: string; start?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && (!start || k >= start)).sort().slice(0, limit ?? Infinity)
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]))
  }
}

const BASE = 'https://grndwrk-store.clinic.workers.dev'
const OWNER = 'owner-secret-for-tests'

/** The Worker as Cloudflare runs it: one object, with storage of its own, per project. */
function deploy(extra: Partial<Env> = {}) {
  const objects = new Map<string, StoreObject>()
  const storages = new Map<string, MemoryStorage>()
  const env: Env = {
    OWNER_AUTH: OWNER,
    ...extra,
    STORE: {
      idFromName: (name) => name,
      get: (id) => {
        const name = id as string
        if (!objects.has(name)) {
          storages.set(name, new MemoryStorage())
          objects.set(name, new StoreObject({ storage: storages.get(name)! }, env))
        }
        return objects.get(name)!
      },
    },
  }
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => worker.fetch(new Request(input, init), env)) as typeof fetch
  const mint = async (project: string, body: Record<string, unknown>) => {
    const res = await fetcher(`${BASE}/${project}/admin/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: JSON.stringify(body) })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; token: string; role: string; commenter?: string }
  }
  return { fetcher, mint, storages }
}

const text = (s: string) => new TextEncoder().encode(s)

describe('the Cloudflare store', () => {
  it('serves the page from its static assets, and the Comment button to the staging site only', async () => {
    // Workers static assets with html_handling "none": each file by its own name.
    const ASSETS = { fetch: async (req: Request) => {
      const name = new URL(req.url).pathname.slice(1)
      return name in PAGE_FILES ? new Response(PAGE_FILES[name]) : new Response('Not found', { status: 404 })
    } }
    const site = 'https://staging.clinic.example'
    const { fetcher } = deploy({ ASSETS, COMMENT_ORIGINS: site })
    await expectServesPage((path, referer) => fetcher(`${BASE}/clinic${path}`, { headers: referer ? { Referer: referer } : {} }), 'clinic', `${BASE}/clinic/`, site)
    // The protocol is still the protocol.
    expect((await fetcher(`${BASE}/clinic/v1/hello`)).status).toBe(401)
  })

  it('keeps every rule of the protocol, the HTTP ones too', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    const url = `${BASE}/clinic/`
    const results = await checkStore(new HttpStore(url, token, fetcher), { url, token, fetcher })
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.length).toBeGreaterThan(15)
  })

  it('keeps a token to its own project', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    expect((await new HttpStore(`${BASE}/clinic/`, token, fetcher).hello()).project).toBe('clinic')
    await expect(new HttpStore(`${BASE}/clinic-two/`, token, fetcher).hello()).rejects.toThrow(/401/)
  })

  it('lists the one project a token belongs to at its root, read only', async () => {
    const { fetcher, mint } = deploy()
    const list = (token?: string, method = 'GET') => fetcher(`${BASE}/v1/projects`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const writer = await mint('clinic', { role: 'write' })
    expect(writer.token).toMatch(/^gws_clinic\./)
    expect(await (await list(writer.token)).json()).toEqual({ projects: [{ name: 'clinic', url: `${BASE}/clinic/` }] })
    expect(await (await list((await mint('clinic', { role: 'read' })).token)).json()).toEqual({ projects: [{ name: 'clinic', url: `${BASE}/clinic/` }] })
    // A comment token reads no map; a token that names a project it is not in, or none, is no token; older tokens say no project.
    expect(await (await list((await mint('clinic', { role: 'comment' })).token)).json()).toEqual({ projects: [] })
    expect((await list(writer.token.replace('gws_clinic.', 'gws_kennel.'))).status).toBe(401)
    expect((await list()).status).toBe(401)
    expect((await list('gws_somethingolder')).status).toBe(404)
    expect((await list(writer.token, 'PUT')).status).toBe(405)
  })

  it('refuses a project name that is not one, and http to another machine', async () => {
    const { fetcher } = deploy()
    for (const p of ['/Clinic/v1/hello', '/_x/v1/hello', '/v1/hello', '/a.b/v1/hello']) expect((await fetcher(BASE + p)).status).toBe(404)
    expect((await fetcher('http://grndwrk-store.clinic.workers.dev/clinic/v1/hello')).status).toBe(400)
  })

  it('never lets a stale write overwrite, even when two arrive at once', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    const store = new HttpStore(`${BASE}/clinic/`, token, fetcher)
    const first = await store.write('nodes/n_race01.md', text('one'), { type: 'text/markdown', create: true })
    if (!first.ok) throw new Error('refused')
    const both = await Promise.all(['two', 'three'].map((w) => store.write('nodes/n_race01.md', text(w), { type: 'text/markdown', ifVersion: first.version })))
    expect(both.filter((w) => w.ok)).toHaveLength(1)
    const won = both.find((w) => w.ok)!
    expect(both.find((w) => !w.ok)?.version).toBe(won.version)
    expect((await store.read('nodes/n_race01.md'))?.version).toBe(won.version)
  })

  it('keeps files larger than one storage value, in chunks, and drops the old chunks', async () => {
    const { fetcher, mint, storages } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    const store = new HttpStore(`${BASE}/clinic/`, token, fetcher)
    const big = new Uint8Array(CHUNK * 5 + 17)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (let i = 8; i < big.length; i++) big[i] = i % 251
    const w = await store.write('files/n_big001/scan.png', big, { type: 'image/png', create: true })
    if (!w.ok) throw new Error('refused')
    expect((await store.read('files/n_big001/scan.png'))?.bytes).toEqual(big)
    const blobs = () => [...storages.get('clinic')!.data.keys()].filter((k) => k.startsWith('blob:')).length
    expect(blobs()).toBe(6)
    await store.write('files/n_big001/scan.png', big.slice(0, 100), { type: 'image/png', ifVersion: w.version })
    expect(blobs()).toBe(1)
    const tooBig = new Uint8Array(10_000_001)
    tooBig.set(big.slice(0, 8))
    expect((await fetcher(`${BASE}/clinic/v1/files/files/n_big001/huge.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body: tooBig })).status).toBe(413)
  })

  it('pages changes with more, and holds a long poll until something changes', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    const store = new HttpStore(`${BASE}/clinic/`, token, fetcher)
    const start = await store.changes({})
    for (let i = 0; i < 503; i++) await store.write(`nodes/n_p${String(i).padStart(5, '0')}.md`, text('x'), { type: 'text/markdown', create: true })
    const first = await store.changes({ since: start.cursor })
    expect(first.changes).toHaveLength(500)
    expect(first.more).toBe(true)
    const rest = await store.changes({ since: first.cursor })
    expect(rest.changes).toHaveLength(3)
    expect(rest.more).toBe(false)
    const all = await store.changes({})
    expect(all.more).toBe(true)
    const waiting = store.changes({ since: rest.cursor, wait: 5 })
    setTimeout(() => void store.write('nodes/n_late01.md', text('d'), { type: 'text/markdown', create: true }), 50)
    expect((await waiting).changes.map((c) => c.path)).toEqual(['nodes/n_late01.md'])
  })

  it('refuses writes from a token that may only read', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'read' })
    const store = new HttpStore(`${BASE}/clinic/`, token, fetcher)
    expect(await store.hello()).toMatchObject({ writable: false, role: 'read' })
    await expect(store.write('nodes/n_rdonly.md', text('x'), { type: 'text/markdown', create: true })).rejects.toThrow(/403/)
  })
})

describe('tokens', () => {
  it('are minted and revoked only by whoever deployed it, and kept only as a hash', async () => {
    const { fetcher, mint, storages } = deploy()
    expect((await fetcher(`${BASE}/clinic/admin/tokens`, { method: 'POST', headers: { Authorization: 'Bearer guess' }, body: '{"role":"write"}' })).status).toBe(401)
    const t = await mint('clinic', { role: 'write', label: 'Front desk Mac' })
    expect(t.token).toMatch(/^gws_/)
    expect(JSON.stringify([...storages.get('clinic')!.data])).not.toContain(t.token)
    const list = (await (await fetcher(`${BASE}/clinic/admin/tokens`, { headers: { Authorization: `Bearer ${OWNER}` } })).json()) as { tokens: { id: string; token?: string }[] }
    expect(list.tokens.map((x) => x.id)).toEqual([t.id])
    expect(list.tokens[0].token).toBeUndefined()
    const hello = () => fetcher(`${BASE}/clinic/v1/hello`, { headers: { Authorization: `Bearer ${t.token}` } })
    expect((await hello()).status).toBe(200)
    expect((await fetcher(`${BASE}/clinic/admin/tokens/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${OWNER}` } })).status).toBe(200)
    expect((await hello()).status).toBe(401)
  })

  it('refuses a role or commenter that is not one, and works not at all without OWNER_AUTH', async () => {
    const { fetcher } = deploy()
    const post = (body: unknown) => fetcher(`${BASE}/clinic/admin/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: JSON.stringify(body) })
    expect((await post({ role: 'owner' })).status).toBe(400)
    expect((await post({ role: 'comment', commenter: '../x' })).status).toBe(400)
    const none = deploy({ OWNER_AUTH: undefined })
    expect((await none.fetcher(`${BASE}/clinic/admin/tokens`, { method: 'POST', headers: { Authorization: 'Bearer ' }, body: '{"role":"write"}' })).status).toBe(403)
  })
})

describe('comments straight to the store', () => {
  async function setup() {
    const d = deploy()
    const writer = await d.mint('clinic', { role: 'write' })
    const phone = await d.mint('clinic', { role: 'comment', commenter: 'dev_phone01', name: 'Front desk' })
    const call = (method: string, path: string, token: string, body?: string, headers: Record<string, string> = {}) =>
      d.fetcher(`${BASE}/clinic/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body })
    const put = (path: string, token: string, body = '{"text":"The weight field is too small","from":"Somebody else"}') => call('PUT', `files/${path}`, token, body, { 'Content-Type': 'application/json', 'If-None-Match': '*' })
    return { ...d, writer: writer.token, phone: phone.token, call, put }
  }

  it('lets a commenter leave a comment in its own inbox only, under the name the store knows', async () => {
    const { put, phone, writer, fetcher } = await setup()
    expect((await put('inbox/dev_phone01/c_00000001.json', phone)).status).toBe(201)
    const r = await new HttpStore(`${BASE}/clinic/`, writer, fetcher).read('inbox/dev_phone01/c_00000001.json')
    expect(JSON.parse(new TextDecoder().decode(r!.bytes))).toEqual({ text: 'The weight field is too small', from: 'Front desk' })
    expect((await put('inbox/dev_other01/c_00000002.json', phone)).status).toBe(403)
    expect((await put('inbox/dev_phone01/c_00000003.json', phone, '[1]')).status).toBe(400)
    expect(await new HttpStore(`${BASE}/clinic/`, phone, fetcher).hello()).toMatchObject({ role: 'comment', commenter: 'dev_phone01' })
    expect((await new HttpStore(`${BASE}/clinic/`, writer, fetcher).hello()).commenter).toBeUndefined()
  })

  it('refuses everything else to a commenter', async () => {
    const { put, call, phone } = await setup()
    expect((await put('nodes/n_phone1.md', phone, 'x')).status).toBe(403)
    expect((await call('PUT', 'files/inbox/dev_phone01/c_00000001.json', phone, '{}', { 'If-Match': '"v1"' })).status).toBe(403)
    expect((await call('DELETE', 'files/inbox/dev_phone01/c_00000001.json', phone, undefined, { 'If-Match': '"v1"' })).status).toBe(403)
    expect((await call('GET', 'changes', phone)).status).toBe(403)
    expect((await call('GET', 'files/project.md', phone)).status).toBe(403)
    expect((await call('GET', 'files/inbox/dev_phone01/c_00000001.json', phone)).status).toBe(403)
    expect((await call('GET', 'files/status/dev_other01.json', phone)).status).toBe(403)
  })

  it('lets a commenter read its own status, written by grndwrk', async () => {
    const { call, put, phone, writer } = await setup()
    expect((await call('GET', 'files/status/dev_phone01.json', phone)).status).toBe(404)
    expect((await put('status/dev_phone01.json', writer, '{"comments":[]}')).status).toBe(201)
    const res = await call('GET', 'files/status/dev_phone01.json', phone)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"comments":[]}')
  })
})

describe('Cloudflare Access, as an option', () => {
  const TEAM = 'clinic.cloudflareaccess.com'
  const AUD = 'aud-for-tests'
  const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url')

  async function signer() {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const certs = (async () => Response.json({ keys: [{ ...jwk, kid: 'k1' }] })) as unknown as typeof fetch
    const sign = async (claims: Record<string, unknown>, key = pair.privateKey) => {
      const body = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64url(JSON.stringify(claims))}`
      return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body))))}`
    }
    return { certs, sign }
  }
  const roles = JSON.stringify({ clinic: { 'vet@clinic.example': 'write', '*@clinic.example': 'read', 'desk@front.example': 'comment' } })
  const req = (jwt: string) => new Request(`${BASE}/clinic/v1/hello`, { headers: { 'Cf-Access-Jwt-Assertion': jwt, 'Cf-Access-Authenticated-User-Email': 'vet@clinic.example' } })

  it('gives the role the allow list names for the email in a signed token', async () => {
    const { certs, sign } = await signer()
    const identify = access({ team: TEAM, aud: AUD, roles }, certs)
    const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: Date.now() / 1000 + 60 }
    expect(await identify(req(await sign({ ...claims, email: 'vet@clinic.example' })), 'clinic')).toEqual({ role: 'write' })
    expect(await identify(req(await sign({ ...claims, email: 'nurse@clinic.example' })), 'clinic')).toEqual({ role: 'read' })
    expect(await identify(req(await sign({ ...claims, email: 'desk@front.example' })), 'clinic')).toMatchObject({ role: 'comment', name: 'desk@front.example', commenter: expect.stringMatching(/^access_[0-9a-f]{32}$/) })
    // Not on the list, another project, another audience, expired.
    expect(await identify(req(await sign({ ...claims, email: 'someone@else.example' })), 'clinic')).toBeNull()
    expect(await identify(req(await sign({ ...claims, email: 'vet@clinic.example' })), 'shop')).toBeNull()
    expect(await identify(req(await sign({ ...claims, aud: ['other'], email: 'vet@clinic.example' })), 'clinic')).toBeNull()
    expect(await identify(req(await sign({ ...claims, exp: Date.now() / 1000 - 1, email: 'vet@clinic.example' })), 'clinic')).toBeNull()
  })

  it('never believes the email header alone, or a token signed with another key', async () => {
    const { certs } = await signer()
    const other = await signer()
    const identify = access({ team: TEAM, aud: AUD, roles }, certs)
    expect(await identify(req(''), 'clinic')).toBeNull()
    const forged = await other.sign({ aud: [AUD], iss: `https://${TEAM}`, exp: Date.now() / 1000 + 60, email: 'vet@clinic.example' })
    expect(await identify(req(forged), 'clinic')).toBeNull()
    expect(() => access({ team: 'evil.example.com', aud: AUD, roles }, certs)).toThrow(/cloudflareaccess/)
  })

  it('lists every project the allow list lets the person read, and none to someone it does not', async () => {
    const { certs, sign } = await signer()
    const many = JSON.stringify({ clinic: { 'vet@clinic.example': 'write' }, 'clinic-admin': { '*@clinic.example': 'read' }, kennel: { 'vet@clinic.example': 'comment' }, shop: {} })
    const identify = access({ team: TEAM, aud: AUD, roles: many }, certs)
    const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: Date.now() / 1000 + 60 }
    // Through Access no project's object is asked: the allow list says it all.
    const STORE = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) }
    const ask = async (email: string) => listProjects(new Request(`${BASE}/v1/projects`, { headers: { 'Cf-Access-Jwt-Assertion': await sign({ ...claims, email }) } }), STORE, identify, many)
    expect(await (await ask('vet@clinic.example')).json()).toEqual({ projects: [{ name: 'clinic', url: `${BASE}/clinic/` }, { name: 'clinic-admin', url: `${BASE}/clinic-admin/` }] })
    expect((await ask('someone@else.example')).status).toBe(401)
  })
})

describe('a staging site, with CORS', () => {
  const SITE = 'https://staging.clinic.example'
  async function setup() {
    const d = deploy({ COMMENT_ORIGINS: `${SITE}, http://not-https.example` })
    const writer = (await d.mint('clinic', { role: 'write' })).token
    const reader = (await d.mint('clinic', { role: 'read' })).token
    const phone = (await d.mint('clinic', { role: 'comment', commenter: 'dev_phone01' })).token
    const call = (method: string, path: string, token: string | null, origin = SITE, headers: Record<string, string> = {}, body?: string) =>
      d.fetcher(`${BASE}/clinic/v1/${path}`, { method, body, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } })
    const put = (path: string, token: string | null, origin = SITE, body = '{"text":"The weight field is too small"}') =>
      call('PUT', `files/${path}`, token, origin, { 'Content-Type': 'application/json', 'If-None-Match': '*' }, body)
    return { writer, reader, phone, call, put }
  }
  const allowed = (res: Response) => res.headers.get('access-control-allow-origin')

  it('answers the three comment calls from a listed site, with the exact origin', async () => {
    const { call, put, phone, writer } = await setup()
    const hello = await call('GET', 'hello', phone)
    expect(allowed(hello)).toBe(SITE)
    expect(hello.headers.get('access-control-allow-methods')).toBe('GET, PUT')
    expect(hello.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type, If-None-Match')
    expect(hello.headers.get('access-control-expose-headers')).toBe('ETag')
    expect(hello.headers.get('vary')).toBe('Origin')
    const left = await put('inbox/dev_phone01/c_00000001.json', phone)
    expect(left.status).toBe(201)
    expect(allowed(left)).toBe(SITE)
    await put('status/dev_phone01.json', writer, SITE, '{"comments":[]}')
    const status = await call('GET', 'files/status/dev_phone01.json', phone)
    expect(status.status).toBe(200)
    expect(allowed(status)).toBe(SITE)
  })

  it('gives another site, a site that is not https, and other calls no CORS', async () => {
    const { call, put, phone } = await setup()
    expect(allowed(await call('GET', 'hello', phone, 'https://elsewhere.example'))).toBeNull()
    expect(allowed(await call('GET', 'hello', phone, 'http://not-https.example'))).toBeNull()
    const changes = await call('GET', 'changes', phone)
    expect(changes.status).toBe(403)
    expect(allowed(changes)).toBeNull()
    expect(allowed(await put('nodes/n_phone1.md', phone, SITE, 'x'))).toBeNull()
  })

  it('never gives CORS to a read or write token, even from the listed site', async () => {
    const { call, put, reader, writer } = await setup()
    for (const t of [reader, writer]) {
      expect(allowed(await call('GET', 'hello', t))).toBeNull()
      expect(allowed(await call('GET', 'files/status/dev_phone01.json', t))).toBeNull()
    }
    expect(allowed(await put('inbox/dev_phone01/c_00000009.json', writer))).toBeNull()
  })

  it('lets the page read a 401 or 403 on those calls, so it can ask the person to log in again', async () => {
    const { call, put, phone } = await setup()
    const none = await call('GET', 'hello', null)
    expect(none.status).toBe(401)
    expect(allowed(none)).toBe(SITE)
    const revoked = await put('inbox/dev_phone01/c_00000002.json', 'gws_revoked')
    expect(revoked.status).toBe(401)
    expect(allowed(revoked)).toBe(SITE)
    const other = await put('inbox/dev_other01/c_00000002.json', phone)
    expect(other.status).toBe(403)
    expect(allowed(other)).toBe(SITE)
    const theirs = await call('GET', 'files/status/dev_other01.json', phone)
    expect(theirs.status).toBe(403)
    expect(allowed(theirs)).toBe(SITE)
  })

  it('answers the preflight for those calls from a listed site only', async () => {
    const { call } = await setup()
    const pre = (path: string, method: string, origin = SITE) =>
      call('OPTIONS', path, null, origin, { 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization, content-type, if-none-match' })
    for (const [path, method] of [['hello', 'GET'], ['files/inbox/dev_phone01/c_00000001.json', 'PUT'], ['files/status/dev_phone01.json', 'GET']]) {
      const res = await pre(path, method)
      expect(res.status).toBe(204)
      expect(allowed(res)).toBe(SITE)
    }
    for (const [path, method, origin] of [['hello', 'GET', 'https://elsewhere.example'], ['changes', 'GET', SITE], ['files/nodes/n_x00001.md', 'PUT', SITE], ['files/inbox/dev_phone01/c_00000001.json', 'DELETE', SITE]]) {
      const res = await pre(path, method, origin)
      expect(res.status).toBe(403)
      expect(allowed(res)).toBeNull()
    }
  })
})

describe('from the protocol', () => {
  it('takes a write with both If-Match and If-None-Match: * as a create', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    const put = (body: string) =>
      fetcher(`${BASE}/clinic/v1/files/nodes/n_both01.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*', 'If-Match': '"v1"' }, body })
    expect((await put('one')).status).toBe(201)
    expect((await put('two')).status).toBe(412)
  })

  it('refuses an inbox body that is not a JSON object, from any token', async () => {
    const { fetcher, mint } = deploy()
    const writer = (await mint('clinic', { role: 'write' })).token
    const phone = (await mint('clinic', { role: 'comment', commenter: 'dev_phone01' })).token
    let n = 0
    for (const [token, body] of [[writer, '[1]'], [writer, 'not json'], [phone, '"words"'], [phone, 'null']]) {
      const res = await fetcher(`${BASE}/clinic/v1/files/inbox/dev_phone01/c_0000000${++n}.json`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body })
      expect(res.status).toBe(400)
    }
  })
})

describe('what a comment token may send', () => {
  /** A store with small limits and a clock the test moves. */
  async function small(limits = {}) {
    const storage = new MemoryStorage()
    let now = Date.UTC(2026, 10, 16, 9)
    const store = new Store(storage, { ownerAuth: OWNER, limits: { filesPerHour: 3, bytesPerHour: 1000, waiting: 4, total: 6, ...limits }, now: () => now })
    const call = (path: string, init: RequestInit = {}) => store.handle(new Request(`${BASE}/clinic/${path}`, init), 'clinic')
    const mint = async (body: Record<string, unknown>) => ((await (await call('admin/tokens', { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: JSON.stringify(body) })).json()) as { token: string }).token
    const put = (token: string, path: string, body = '{"text":"The weight field is too small"}') =>
      call(`v1/files/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body })
    return { storage, call, mint, put, later: (ms: number) => (now += ms) }
  }

  it('takes at most so many comments and bytes an hour from one commenter, then 429', async () => {
    const { mint, put, later } = await small()
    const phone = await mint({ role: 'comment', commenter: 'dev_phone01' })
    const other = await mint({ role: 'comment', commenter: 'dev_phone02' })
    for (let i = 1; i <= 3; i++) expect((await put(phone, `inbox/dev_phone01/c_0000000${i}.json`)).status).toBe(201)
    const refused = await put(phone, 'inbox/dev_phone01/c_00000004.json')
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: string }).error).toMatch(/an hour/)
    // Another commenter has its own hour.
    expect((await put(other, 'inbox/dev_phone02/c_00000001.json', JSON.stringify({ text: 'x'.repeat(900) }))).status).toBe(201)
    expect((await put(other, 'inbox/dev_phone02/c_00000002.json', JSON.stringify({ text: 'x'.repeat(200) }))).status).toBe(429)
    later(3_600_001)
    expect((await put(phone, 'inbox/dev_phone01/c_00000004.json')).status).toBe(201)
  })

  it('keeps at most so many waiting per commenter and in the whole inbox, and never holds teammates to it', async () => {
    const { mint, put, later } = await small({ filesPerHour: 100, bytesPerHour: 1e9 })
    const writer = await mint({ role: 'write' })
    const a = await mint({ role: 'comment', commenter: 'dev_phone01' })
    const b = await mint({ role: 'comment', commenter: 'dev_phone02' })
    for (let i = 1; i <= 4; i++) expect((await put(a, `inbox/dev_phone01/c_0000000${i}.json`)).status).toBe(201)
    expect((await put(a, 'inbox/dev_phone01/c_00000005.json')).status).toBe(429)
    later(3_600_001)
    expect((await put(a, 'inbox/dev_phone01/c_00000005.json')).status).toBe(429)
    expect((await put(b, 'inbox/dev_phone02/c_00000001.json')).status).toBe(201)
    expect((await put(b, 'inbox/dev_phone02/c_00000002.json')).status).toBe(201)
    // Six in all: the whole inbox is full for every commenter.
    expect((await put(b, 'inbox/dev_phone02/c_00000003.json')).status).toBe(429)
    // A teammate files and writes as before.
    expect((await put(writer, 'inbox/dev_phone02/c_00000009.json')).status).toBe(201)
  })

  it('reads the limits from the settings', () => {
    expect(limitsOf({ INBOX_FILES_PER_HOUR: '10', INBOX_MB_PER_HOUR: '5', INBOX_WAITING: 'lots', INBOX_TOTAL: '0' } as Env)).toEqual({ filesPerHour: 10, bytesPerHour: 5_000_000 })
  })

  it('stops reading a body at the limit, with or without Content-Length', async () => {
    const { fetcher, mint } = deploy()
    const { token } = await mint('clinic', { role: 'write' })
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(256 * 1024).fill(65))) })
    const res = await fetcher(`${BASE}/clinic/v1/files/nodes/n_huge01.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body: endless, duplex: 'half' } as RequestInit)
    expect(res.status).toBe(413)
    expect(pulled).toBeLessThan(10)
    const said = await fetcher(`${BASE}/clinic/v1/files/nodes/n_huge02.md`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*', 'Content-Length': '2000000' }, body: 'x' })
    expect(said.status).toBe(413)
  })

  it('never answers a failure with its own words', async () => {
    const broken = new MemoryStorage()
    broken.get = async () => {
      throw new Error('storage at 10.0.0.7 refused the key')
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await new Store(broken, {}).handle(new Request(`${BASE}/clinic/v1/hello`, { headers: { Authorization: 'Bearer gws_clinic.x' } }), 'clinic')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Something went wrong' })
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('the name on a comment, and what teammates learn from hello', () => {
  it('sets from to the name the store knows, or takes away the one the device sent', async () => {
    const site = 'https://staging.clinic.example'
    const { fetcher, mint } = deploy({ COMMENT_ORIGINS: `${site}, https://second.clinic.example` })
    const writer = (await mint('clinic', { role: 'write' })).token
    const nameless = (await mint('clinic', { role: 'comment', commenter: 'dev_noname1' })).token
    const put = (token: string, path: string) =>
      fetcher(`${BASE}/clinic/v1/files/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body: '{"text":"Hi","from":"The vet in charge"}' })
    expect((await put(nameless, 'inbox/dev_noname1/c_00000001.json')).status).toBe(201)
    const store = new HttpStore(`${BASE}/clinic/`, writer, fetcher)
    expect(JSON.parse(new TextDecoder().decode((await store.read('inbox/dev_noname1/c_00000001.json'))!.bytes))).toEqual({ text: 'Hi' })
    // A teammate filing by hand writes what it writes.
    expect((await put(writer, 'inbox/dev_noname1/c_00000002.json')).status).toBe(201)
    expect(JSON.parse(new TextDecoder().decode((await store.read('inbox/dev_noname1/c_00000002.json'))!.bytes)).from).toBe('The vet in charge')
    const hello = async (token: string) => (await fetcher(`${BASE}/clinic/v1/hello`, { headers: { Authorization: `Bearer ${token}` } })).json()
    expect(await hello(writer)).toMatchObject({ names: true, site })
    expect(await hello((await mint('clinic', { role: 'read' })).token)).toMatchObject({ names: true, site })
    const phone = (await hello(nameless)) as Record<string, unknown>
    expect(phone.names).toBeUndefined()
    expect(phone.site).toBeUndefined()
    // Without a staging site, no site.
    const plain = deploy()
    const t = (await plain.mint('clinic', { role: 'write' })).token
    expect(await (await plain.fetcher(`${BASE}/clinic/v1/hello`, { headers: { Authorization: `Bearer ${t}` } })).json()).toEqual({ protocol: 1, project: 'clinic', writable: true, role: 'write', names: true })
  })
})

describe('Cloudflare Access keys and times', () => {
  const TEAM = 'clinic.cloudflareaccess.com'
  const AUD = 'aud-for-tests'
  const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url')
  const roles = JSON.stringify({ clinic: { 'vet@clinic.example': 'write' } })
  const key = async () => (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const sign = async (kid: string, pair: CryptoKeyPair, claims: Record<string, unknown>) => {
    const body = `${b64url(JSON.stringify({ alg: 'RS256', kid }))}.${b64url(JSON.stringify(claims))}`
    return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(body))))}`
  }
  const req = (jwt: string) => new Request(`${BASE}/clinic/v1/hello`, { headers: { 'Cf-Access-Jwt-Assertion': jwt } })

  it('refuses a token before its nbf, and fetches the keys again for a new kid, at most once a minute', async () => {
    const [one, two] = [await key(), await key()]
    let published = [{ ...(await crypto.subtle.exportKey('jwk', one.publicKey)), kid: 'k1' }]
    let fetches = 0
    const certs = (async () => (fetches++, Response.json({ keys: published }))) as unknown as typeof fetch
    let now = Date.now()
    const identify = access({ team: TEAM, aud: AUD, roles }, certs, () => now)
    const claims = { aud: [AUD], iss: `https://${TEAM}`, exp: now / 1000 + 600, email: 'vet@clinic.example' }
    expect(await identify(req(await sign('k1', one, claims)), 'clinic')).toEqual({ role: 'write' })
    expect(await identify(req(await sign('k1', one, { ...claims, nbf: now / 1000 + 60 })), 'clinic')).toBeNull()
    expect(await identify(req(await sign('k1', one, { ...claims, nbf: now / 1000 - 1 })), 'clinic')).toEqual({ role: 'write' })
    expect(fetches).toBe(1)
    // Rotated: unknown at first, then fetched again, once, after a minute.
    const rotated = await sign('k2', two, claims)
    expect(await identify(req(rotated), 'clinic')).toBeNull()
    expect(fetches).toBe(1)
    published = [...published, { ...(await crypto.subtle.exportKey('jwk', two.publicKey)), kid: 'k2' }]
    now += 61_000
    expect(await identify(req(rotated), 'clinic')).toEqual({ role: 'write' })
    expect(fetches).toBe(2)
    expect(await identify(req(await sign('k9', two, claims)), 'clinic')).toBeNull()
    expect(fetches).toBe(2)
  })
})
