import { describe, expect, it } from 'vitest'
import { checkStore } from '../src/shared-store/check.js'
import { HttpStore } from '../src/shared-store/http.js'
import { CursorGone, pathProblem as grndwrkPathProblem, bytesProblem as grndwrkBytesProblem, INBOX, MAX_INBOX, MAX_PICTURE, MAX_TEXT, type StoreClient } from '../src/shared-store/protocol.js'
import { bytesProblem, INLINE, pathProblem, storeOver, MAX_INBOX as FB_MAX_INBOX, MAX_PICTURE as FB_MAX_PICTURE, MAX_TEXT as FB_MAX_TEXT, INBOX as FB_INBOX } from '../stores/firebase/adapter.mjs'
import { keyHash, storeFunction } from '../stores/firebase/functions.mjs'

type Doc = Record<string, unknown>

/**
 * Firestore and Storage in memory, as the store uses them: documents by
 * path, transactions that run one at a time and apply their writes at the
 * end (reads first, as Firestore insists), a query by `at`, and blobs.
 */
function fakeFirebase() {
  const docs = new Map<string, Doc>()
  const blobs = new Map<string, Uint8Array>()
  const copy = (d: Doc | undefined) => (d ? structuredClone(d) : null)
  let queue: Promise<unknown> = Promise.resolve()
  const backend = {
    docs,
    blobs,
    get: async (path: string) => copy(docs.get(path)),
    transaction<T>(fn: (tx: { get(p: string): Promise<Doc | null>; set(p: string, d: Doc): void; delete(p: string): void }) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const writes: [string, Doc | null][] = []
        const result = await fn({
          get: async (p) => {
            if (writes.length) throw new Error('Firestore transactions read everything before they write')
            return copy(docs.get(p))
          },
          set: (p, d) => void writes.push([p, structuredClone(d)]),
          delete: (p) => void writes.push([p, null]),
        })
        for (const [p, d] of writes) d ? docs.set(p, d) : docs.delete(p)
        return result
      })
      queue = run.catch(() => {})
      return run
    },
    after: async (collection: string, at: number, limit: number) =>
      [...docs]
        .filter(([p, d]) => p.startsWith(`${collection}/`) && !p.slice(collection.length + 1).includes('/') && (d.at as number) > at)
        .map(([, d]) => structuredClone(d))
        .sort((a, b) => (a.at as number) - (b.at as number))
        .slice(0, limit),
    save: async (name: string, bytes: Uint8Array) => void blobs.set(name, new Uint8Array(bytes)),
    load: async (name: string) => blobs.get(name) ?? null,
    drop: async (name: string) => void blobs.delete(name),
  }
  return backend
}

/** What grndwrk's loader should do with an adapter's unknown cursor: its own CursorGone cannot reach an adapter. */
function asGrndwrk(store: ReturnType<typeof storeOver>): StoreClient {
  return {
    ...store,
    changes: (o) =>
      store.changes(o).catch((err: Error) => {
        throw err.name === 'CursorGone' ? new CursorGone(err.message) : err
      }),
  }
}

const text = (s: string) => new TextEncoder().encode(s)

/** A function over a fake Firebase, with members, reached through fetch as grndwrk reaches it. */
function setup() {
  const fb = fakeFirebase()
  const handle = storeFunction({ backend: fb, verify: async (t) => (t.startsWith('idtoken-') ? { uid: t.slice(8) } : null) })
  const members: Record<string, Doc> = {
    uid_writer01: { role: 'write' },
    uid_reader01: { role: 'read' },
    uid_phone001: { role: 'comment', name: 'Front desk iPad' },
    uid_web00001: { role: 'comment', commenter: 'dev_staging1' },
  }
  for (const [uid, m] of Object.entries(members)) fb.docs.set(`projects/clinic/members/${uid}`, m)
  fb.docs.set('projects/clinic', { name: 'Clinic', site: 'https://staging.vetclinic.example' })
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch
  const url = 'https://europe-west1-vet-clinic.cloudfunctions.net/store/clinic/'
  return { fb, fetcher, url, as: (token: string) => new HttpStore(url, token, fetcher) }
}

describe('the Firebase store keeps the same rules as grndwrk', () => {
  it('has the same paths, types and sizes as src/shared-store/protocol.ts', () => {
    const paths = ['project.md', 'nodes/n_abc123.md', 'files/n_abc123/plan.png', 'files/n_x/p.JPEG', 'inbox/dev_phone01/c_00000001.json', 'status/dev_phone01.json', 'inbox/short/c_00000001.json', 'local.json', 'store.json', 'nodes/../local.json', '/nodes/x.md', 'nodes/.hidden.md', 'nodes\\x.md', 'nodes/x.svg', `nodes/${'a'.repeat(300)}.md`, 'a/b/c/d/e/f/g/h/i.md', '']
    for (const p of paths) expect(pathProblem(p), p).toBe(grndwrkPathProblem(p))
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    for (const [p, b] of [['files/n_x/a.png', png], ['files/n_x/a.png', text('<svg>')], ['files/n_x/a.jpg', png], ['nodes/n_x.md', new Uint8Array(MAX_TEXT + 1)], ['inbox/dev_phone01/c_00000001.json', new Uint8Array(MAX_TEXT + 1)]] as const) expect(bytesProblem(p, b)).toBe(grndwrkBytesProblem(p, b))
    expect([FB_MAX_TEXT, FB_MAX_PICTURE, FB_MAX_INBOX, FB_INBOX.source]).toEqual([MAX_TEXT, MAX_PICTURE, MAX_INBOX, INBOX.source])
  })
})

describe('the adapter over Firestore', () => {
  it('keeps every rule of the protocol', async () => {
    const results = await checkStore(asGrndwrk(storeOver(fakeFirebase(), 'clinic', { name: 'Clinic' })))
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.length).toBeGreaterThan(10)
  })

  it('keeps a large file in Storage, and drops the old blob when it is replaced or deleted', async () => {
    const fb = fakeFirebase()
    const store = storeOver(fb, 'clinic')
    const big = new Uint8Array(INLINE + 10).fill(65)
    const w = await store.write('outputs/brief/1794850638334-xl.md', big, { type: 'text/markdown', create: true })
    expect(w.ok).toBe(true)
    expect(fb.blobs.size).toBe(1)
    expect((await store.read('outputs/brief/1794850638334-xl.md'))?.bytes.length).toBe(INLINE + 10)
    // A refused write leaves no blob behind.
    expect((await store.write('outputs/brief/1794850638334-xl.md', big, { type: 'text/markdown', create: true })).ok).toBe(false)
    expect(fb.blobs.size).toBe(1)
    const w2 = await store.write('outputs/brief/1794850638334-xl.md', text('small now'), { type: 'text/markdown', ifVersion: w.ok ? w.version : '' })
    expect(fb.blobs.size).toBe(0)
    expect(new TextDecoder().decode((await store.read('outputs/brief/1794850638334-xl.md'))?.bytes)).toBe('small now')
    expect((await store.remove('outputs/brief/1794850638334-xl.md', w2.ok ? w2.version : '')).ok).toBe(true)
  })

  it('lets only one of two writes from the same version through', async () => {
    const store = storeOver(fakeFirebase(), 'clinic')
    const w = await store.write('nodes/n_k2m4ab.md', text('Booking should feel like texting'), { type: 'text/markdown', create: true })
    const v = w.ok ? w.version : ''
    const [a, b] = await Promise.all([
      store.write('nodes/n_k2m4ab.md', text('One vet'), { type: 'text/markdown', ifVersion: v }),
      store.write('nodes/n_k2m4ab.md', text('Another vet'), { type: 'text/markdown', ifVersion: v }),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const winner = a.ok ? a : b
    const loser = a.ok ? b : a
    expect(loser.version).toBe(winner.version)
    expect(new TextDecoder().decode((await store.read('nodes/n_k2m4ab.md'))?.bytes)).toBe(a.ok ? 'One vet' : 'Another vet')
  })

  it('pages the changes with more, and keeps each path once at its latest change', async () => {
    const store = storeOver(fakeFirebase(), 'clinic')
    const start = await store.changes({})
    for (let i = 0; i < 502; i++) await store.write(`nodes/n_p${String(i).padStart(5, '0')}.md`, text('x'), { type: 'text/markdown', create: true })
    const first = await store.changes({ since: start.cursor })
    expect(first.changes).toHaveLength(500)
    expect(first.more).toBe(true)
    const rest = await store.changes({ since: first.cursor })
    expect(rest.changes).toHaveLength(2)
    expect(rest.more).toBe(false)
    const r = await store.read('nodes/n_p00000.md')
    await store.remove('nodes/n_p00000.md', r?.version ?? '')
    const after = await store.changes({ since: rest.cursor })
    expect(after.changes).toEqual([{ path: 'nodes/n_p00000.md', deleted: true }])
    // Without a cursor, what exists, never what was deleted.
    let all = 0
    let page = await store.changes({})
    all += page.changes.length
    while (page.more) {
      page = await store.changes({ since: page.cursor })
      all += page.changes.filter((c) => !c.deleted).length
    }
    expect(all).toBe(501)
    await expect(store.changes({ since: 'c_999999' })).rejects.toThrow(/c_999999/)
  })
})

describe('the Cloud Function', () => {
  it('keeps every rule, the HTTP ones too, with an ID token and with a store key', async () => {
    const { fb, fetcher, url, as } = setup()
    expect((await checkStore(as('idtoken-uid_writer01'), { url, token: 'idtoken-uid_writer01', fetcher })).filter((r) => !r.ok)).toEqual([])
    fb.docs.set(`projects/clinic/keys/${keyHash('gk_frontdesk')}`, { uid: 'uid_writer01' })
    expect((await checkStore(as('gk_frontdesk'), { url, token: 'gk_frontdesk', fetcher })).filter((r) => !r.ok)).toEqual([])
    expect((await as('gk_frontdesk').hello()).project).toBe('Clinic')
  })

  it('refuses tokens of no member, and of another map', async () => {
    const { fetcher, url, as } = setup()
    await expect(as('idtoken-uid_stranger').hello()).rejects.toThrow(/401/)
    await expect(as('not-a-token').hello()).rejects.toThrow(/401/)
    await expect(as('gk_nobody').hello()).rejects.toThrow(/401/)
    const other = new HttpStore(url.replace('/clinic/', '/kennel/'), 'idtoken-uid_writer01', fetcher)
    await expect(other.hello()).rejects.toThrow(/401/)
  })

  it('lets a reader read, and refuses its writes and deletes with 403', async () => {
    const { as } = setup()
    const writer = as('idtoken-uid_writer01')
    const w = await writer.write('nodes/n_read01.md', text('Reminders by text'), { type: 'text/markdown', create: true })
    const reader = as('idtoken-uid_reader01')
    expect(await reader.hello()).toMatchObject({ writable: false, role: 'read' })
    expect(new TextDecoder().decode((await reader.read('nodes/n_read01.md'))?.bytes)).toBe('Reminders by text')
    await expect(reader.write('nodes/n_read02.md', text('x'), { type: 'text/markdown', create: true })).rejects.toThrow(/403/)
    await expect(reader.remove('nodes/n_read01.md', w.ok ? w.version : '')).rejects.toThrow(/403/)
  })

  it('takes a write with both conditions as a create', async () => {
    const { fetcher, url } = setup()
    const both = (body: string) => fetcher(new URL('v1/files/nodes/n_both01.md', url), { method: 'PUT', headers: { Authorization: 'Bearer idtoken-uid_writer01', 'If-None-Match': '*', 'If-Match': '"v1"' }, body })
    expect((await both('First')).status).toBe(201)
    expect((await both('Second')).status).toBe(412)
  })

  it('never takes a stale write over HTTP, and names the version there', async () => {
    const { as } = setup()
    const a = as('idtoken-uid_writer01')
    const w = await a.write('nodes/n_stale1.md', text('First'), { type: 'text/markdown', create: true })
    const v1 = w.ok ? w.version : ''
    const w2 = await a.write('nodes/n_stale1.md', text('Second'), { type: 'text/markdown', ifVersion: v1 })
    expect(await a.write('nodes/n_stale1.md', text('Stale'), { type: 'text/markdown', ifVersion: v1 })).toEqual({ ok: false, version: w2.ok ? w2.version : '' })
    expect(await a.remove('nodes/n_stale1.md', v1)).toEqual({ ok: false, version: w2.ok ? w2.version : '' })
    expect(new TextDecoder().decode((await a.read('nodes/n_stale1.md'))?.bytes)).toBe('Second')
  })

  describe('the comment role', () => {
    const put = (fetcher: typeof fetch, url: string, path: string, token: string, body = '{"text":"The weight field is too small","from":"Someone else"}', headers: Record<string, string> = { 'If-None-Match': '*' }) =>
      fetcher(new URL(`v1/files/${path}`, url), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body })
    const get = (fetcher: typeof fetch, url: string, path: string, token: string) => fetcher(new URL(path, url), { headers: { Authorization: `Bearer ${token}` } })

    it('leaves a comment only in its own inbox folder, with the name the store knows', async () => {
      const { fetcher, url, as } = setup()
      expect(await as('idtoken-uid_phone001').hello()).toMatchObject({ role: 'comment', commenter: 'uid_phone001' })
      expect((await as('idtoken-uid_writer01').hello()).commenter).toBeUndefined()
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000001.json', 'idtoken-uid_phone001')).status).toBe(201)
      const comment = JSON.parse(new TextDecoder().decode((await as('idtoken-uid_writer01').read('inbox/uid_phone001/c_00000001.json'))?.bytes))
      expect(comment).toEqual({ text: 'The weight field is too small', from: 'Front desk iPad' })
      // The same id again is refused, as for any create.
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000001.json', 'idtoken-uid_phone001')).status).toBe(412)
      // A member with a commenter id of its own writes under that id, never its uid; without a known name, from stays as sent.
      expect((await put(fetcher, url, 'inbox/dev_staging1/c_00000002.json', 'idtoken-uid_web00001')).status).toBe(201)
      expect(JSON.parse(new TextDecoder().decode((await as('idtoken-uid_writer01').read('inbox/dev_staging1/c_00000002.json'))?.bytes)).from).toBe('Someone else')
      expect((await put(fetcher, url, 'inbox/uid_web00001/c_00000003.json', 'idtoken-uid_web00001')).status).toBe(403)
    })

    it('refuses everything else with 403', async () => {
      const { fetcher, url } = setup()
      const t = 'idtoken-uid_phone001'
      expect((await put(fetcher, url, 'inbox/dev_other01/c_00000002.json', t)).status).toBe(403)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000003.json', t, '{}', {})).status).toBe(403)
      expect((await put(fetcher, url, 'nodes/n_phone1.md', t, 'x')).status).toBe(403)
      expect((await put(fetcher, url, 'status/uid_phone001.json', t, '{}')).status).toBe(403)
      expect((await get(fetcher, url, 'v1/changes', t)).status).toBe(403)
      expect((await get(fetcher, url, 'v1/files/project.md', t)).status).toBe(403)
      expect((await get(fetcher, url, 'v1/files/status/dev_other01.json', t)).status).toBe(403)
      expect((await fetcher(new URL('v1/files/inbox/uid_phone001/c_00000001.json', url), { method: 'DELETE', headers: { Authorization: `Bearer ${t}`, 'If-Match': '"v1"' } })).status).toBe(403)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000004.json', t, 'not json')).status).toBe(400)
    })

    it('reads its own status, written by grndwrk', async () => {
      const { fetcher, url, as } = setup()
      expect((await get(fetcher, url, 'v1/files/status/uid_phone001.json', 'idtoken-uid_phone001')).status).toBe(404)
      await as('idtoken-uid_writer01').write('status/uid_phone001.json', text('{"comments":[]}'), { type: 'application/json', create: true })
      const res = await get(fetcher, url, 'v1/files/status/uid_phone001.json', 'idtoken-uid_phone001')
      expect(res.status).toBe(200)
      expect(res.headers.get('etag')).toMatch(/^"v\d+"$/)
      expect(await res.text()).toBe('{"comments":[]}')
    })

    it('answers CORS for the map\'s staging site, only for what a comment token does', async () => {
      const { fetcher, url } = setup()
      const site = 'https://staging.vetclinic.example'
      const preflight = (path: string, method: string, origin = site) => fetcher(new URL(path, url), { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method } })
      const ok = await preflight('v1/files/inbox/uid_phone001/c_00000009.json', 'PUT')
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe(site)
      expect(ok.headers.get('access-control-allow-methods')).toBe('GET, PUT')
      expect(ok.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type, If-None-Match')
      expect((await preflight('v1/hello', 'GET')).status).toBe(204)
      expect((await preflight('v1/files/status/uid_phone001.json', 'GET')).status).toBe(204)
      for (const [path, method, origin] of [['v1/changes', 'GET', site], ['v1/files/nodes/n_x.md', 'PUT', site], ['v1/files/inbox/uid_phone001/c_00000009.json', 'DELETE', site], ['v1/hello', 'GET', 'https://elsewhere.example']]) {
        const res = await preflight(path, method, origin)
        expect(res.status, path).toBe(403)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
      }
      const from = (token: string, path: string, init: RequestInit = {}) => fetcher(new URL(path, url), { ...init, headers: { Authorization: `Bearer ${token}`, Origin: site, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } })
      const left = await from('idtoken-uid_phone001', 'v1/files/inbox/uid_phone001/c_00000009.json', { method: 'PUT', body: '{"text":"Hi"}', headers: { 'If-None-Match': '*' } })
      expect(left.status).toBe(201)
      expect(left.headers.get('access-control-allow-origin')).toBe(site)
      expect((await from('idtoken-uid_phone001', 'v1/hello')).headers.get('access-control-allow-origin')).toBe(site)
      // A refusal on those calls carries it, so the page can say why; never on anything else.
      const refused = await from('idtoken-uid_phone001', 'v1/files/inbox/dev_other01/c_00000012.json', { method: 'PUT', body: '{}', headers: { 'If-None-Match': '*' } })
      expect([refused.status, refused.headers.get('access-control-allow-origin')]).toEqual([403, site])
      const expired = await from('idtoken-expired', 'v1/hello')
      expect([expired.status, expired.headers.get('access-control-allow-origin')]).toEqual([401, site])
      expect((await from('idtoken-uid_phone001', 'v1/changes')).headers.get('access-control-allow-origin')).toBeNull()
      expect((await from('idtoken-expired', 'v1/files/nodes/n_x.md')).headers.get('access-control-allow-origin')).toBeNull()
      // Never for a teammate's token, never *.
      expect((await from('idtoken-uid_writer01', 'v1/hello')).headers.get('access-control-allow-origin')).toBeNull()
      expect((await from('idtoken-uid_writer01', 'v1/files/project.md')).headers.get('access-control-allow-origin')).toBeNull()
    })

    it('treats inbox and status as files for teammates, and an inbox body must be a JSON object', async () => {
      const { fetcher, url, as } = setup()
      const writer = as('idtoken-uid_writer01')
      const { cursor } = await writer.changes({})
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000010.json', 'idtoken-uid_phone001')).status).toBe(201)
      const c = await writer.changes({ since: cursor })
      expect(c.changes.map((x) => x.path)).toEqual(['inbox/uid_phone001/c_00000010.json'])
      expect(await as('idtoken-uid_reader01').read('inbox/uid_phone001/c_00000010.json')).not.toBeNull()
      expect((await writer.remove('inbox/uid_phone001/c_00000010.json', c.changes[0].version ?? '')).ok).toBe(true)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000011.json', 'idtoken-uid_writer01', '[1,2]')).status).toBe(400)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_00000011.json', 'idtoken-uid_phone001', '"words"')).status).toBe(400)
      expect((await writer.write('status/uid_phone001.json', text('{"comments":[]}'), { type: 'application/json', create: true })).ok).toBe(true)
    })

    it('decides the type by the path, whatever Content-Type says', async () => {
      const { fetcher, url } = setup()
      const res = await fetcher(new URL('v1/files/nodes/n_type01.md', url), { method: 'PUT', headers: { Authorization: 'Bearer idtoken-uid_writer01', 'Content-Type': 'text/html', 'If-None-Match': '*' }, body: '<b>Weight in kg</b>' })
      expect(res.status).toBe(201)
      const back = await fetcher(new URL('v1/files/nodes/n_type01.md', url), { headers: { Authorization: 'Bearer idtoken-uid_writer01' } })
      expect(back.headers.get('content-type')).toBe('text/markdown')
      expect(back.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('takes a comment with its picture up to 14 MB, larger is 413', async () => {
      const { fb, fetcher, url } = setup()
      const picture = 'a'.repeat(INLINE)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_0000big1.json', 'idtoken-uid_phone001', JSON.stringify({ text: 'Blurry x-ray', image: picture }))).status).toBe(201)
      expect(fb.blobs.size).toBe(1)
      expect((await put(fetcher, url, 'inbox/uid_phone001/c_0000big2.json', 'idtoken-uid_phone001', JSON.stringify({ image: 'a'.repeat(MAX_INBOX) }))).status).toBe(413)
    })
  })
})
