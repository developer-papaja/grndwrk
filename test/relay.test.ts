import { describe, expect, it } from 'vitest'
import { Relay, LIMITS, fromBase64, toBase64, type Store } from '../relay/src/relay.js'
import {
  inviteId, open, ownerAuthKey, phoneSealKey, phoneSignKey, randomKey, relayDeviceId, requestSignature, seal, teamAuthKey, teamSealKey,
} from '../relay/src/crypto.js'
import { requestSignature as lanSignature } from '../src/server/devices.js'

class MemoryStore implements Store {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put(key: string, value: unknown) { this.data.set(key, value) }
  async delete(keys: string[]) { for (const k of keys) this.data.delete(k) }
  async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? Infinity)
    return new Map(keys.map((k) => [k, this.data.get(k) as T]))
  }
}

const BASE = 'https://relay.example.workers.dev'
let nonceCount = 0
/** The mailbox the current test's project uses. */
let MB = ''

/** As the Worker does: each mailbox has its own storage. */
function relays(owner: string | undefined, now: () => number) {
  const stores = new Map<string, MemoryStore>()
  return {
    stores,
    handle(req: Request) {
      const mb = /^\/v1\/([a-f0-9]{32})/.exec(new URL(req.url).pathname)?.[1] ?? 'none'
      if (!stores.has(mb)) stores.set(mb, new MemoryStore())
      return new Relay(stores.get(mb)!, owner, now, { overlay: '/* the button */', relay: '/* through the relay */', shot: '/* pictures */' }).handle(req)
    },
  }
}

async function setup() {
  const owner = await ownerAuthKey(randomKey())
  const team = randomKey()
  const auth = await teamAuthKey(team)
  let clock = Date.UTC(2026, 10, 5, 12)
  const relay = relays(owner, () => clock)
  MB = randomKey().slice(0, 32)
  const signed = async (who: string, key: string, method: string, path: string, body: Uint8Array | string = new Uint8Array(), headers: Record<string, string> = {}) => {
    const b = typeof body === 'string' ? new TextEncoder().encode(body) : body
    const time = String(clock)
    const nonce = `nonce-${String(++nonceCount).padStart(12, '0')}`
    const sig = await requestSignature(key, method, path, time, nonce, b)
    return relay.handle(new Request(BASE + path, {
      method,
      body: method === 'GET' ? undefined : (b as BodyInit),
      headers: { 'x-grndwrk-device': who, 'x-grndwrk-time': time, 'x-grndwrk-nonce': nonce, 'x-grndwrk-signature': sig, ...headers },
    }))
  }
  const asTeam = (method: string, path: string, body?: Uint8Array | string) => signed('team', auth, method, path, body)
  const asOwner = (method: string, path: string, body?: Uint8Array | string) => signed('owner', owner, method, path, body)
  expect((await asOwner('PUT', `/v1/${MB}`, JSON.stringify({ team: auth }))).status).toBe(200)
  return { team, auth, owner, relay, signed, asTeam, asOwner, get store() { return relay.stores.get(MB)! }, tick: (ms: number) => (clock += ms), now: () => clock }
}

/** A phone joins with an invite and the team lets it in, as grndwrk and the app will. */
async function joined(t: Awaited<ReturnType<typeof setup>>) {
  const secret = randomKey()
  const inv = await inviteId(secret)
  expect((await t.asTeam('POST', `/v1/${MB}/invites`, JSON.stringify({ id: inv, sealed: 'c2VhbGVk' }))).status).toBe(200)

  const phoneKey = randomKey()
  const sealedJoin = await seal(secret, `join:${inv}`, new TextEncoder().encode(JSON.stringify({ key: phoneKey, name: 'Anna’s iPhone' })))
  expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/join/${inv}`, { method: 'POST', body: sealedJoin as BodyInit }))).status).toBe(202)

  const joins = await (await t.asTeam('GET', `/v1/${MB}/joins`)).json() as { invite: string; sealed: string; body: string }[]
  expect(joins[0].sealed).toBe('c2VhbGVk')
  expect(await (await t.asTeam('GET', `/v1/${MB}/invites`)).json()).toMatchObject([{ id: inv, sealed: 'c2VhbGVk' }])
  const plain = await open(secret, `join:${inv}`, fromBase64(joins[0].body))
  const { key } = JSON.parse(new TextDecoder().decode(plain))
  const sign = await phoneSignKey(key)
  const id = await relayDeviceId(sign)
  const sealedKey = toBase64(await seal(await teamSealKey(t.team), `device:${id}`, new TextEncoder().encode(key)))
  expect((await t.asTeam('PUT', `/v1/${MB}/devices/${id}`, JSON.stringify({ sign, sealed: sealedKey }))).status).toBe(200)
  expect((await t.asTeam('DELETE', `/v1/${MB}/invites/${inv}`)).status).toBe(200)
  return { id, sign, phoneKey, secret, inv, asPhone: (method: string, path: string, body?: Uint8Array | string) => t.signed(id, sign, method, path, body) }
}

describe('relay', () => {
  it('signs requests exactly as --lan does', async () => {
    const key = randomKey()
    const body = new TextEncoder().encode('{"title":"x"}')
    expect(await requestSignature(key, 'post', '/api/feedback', '123', 'abcdefghijklmnop', body))
      .toBe(lanSignature(key, 'post', '/api/feedback', '123', 'abcdefghijklmnop', Buffer.from(body)))
  })

  it('carries a sealed comment from a phone to the team, and status back', async () => {
    const t = await setup()
    const p = await joined(t)
    const seal1 = await phoneSealKey(p.phoneKey)
    const comment = new TextEncoder().encode(JSON.stringify({ path: '/api/feedback', body: { title: 'The button is cut off' } }))
    const left = await p.asPhone('POST', `/v1/${MB}/inbox`, await seal(seal1, `inbox:${p.id}`, comment))
    expect(left.status).toBe(202)

    const list = await (await t.asTeam('GET', `/v1/${MB}/inbox`)).json() as { id: string; device: string; size: number }[]
    expect(list).toHaveLength(1)
    expect(list[0].device).toBe(p.id)
    const got = await t.asTeam('GET', `/v1/${MB}/inbox/${list[0].id}`)
    expect(got.headers.get('x-grndwrk-from')).toBe(p.id)
    const plain = await open(seal1, `inbox:${p.id}`, new Uint8Array(await got.arrayBuffer()))
    expect(JSON.parse(new TextDecoder().decode(plain)).body.title).toBe('The button is cut off')
    expect((await t.asTeam('DELETE', `/v1/${MB}/inbox/${list[0].id}`)).status).toBe(200)
    expect(await (await t.asTeam('GET', `/v1/${MB}/inbox`)).json()).toEqual([])

    expect((await p.asPhone('GET', `/v1/${MB}/outbox`)).status).toBe(204)
    const status = await seal(seal1, `outbox:${p.id}`, new TextEncoder().encode('[{"key":"k","status":"ready"}]'))
    expect((await t.asTeam('PUT', `/v1/${MB}/outbox/${p.id}`, status)).status).toBe(200)
    const back = await p.asPhone('GET', `/v1/${MB}/outbox`)
    expect(new TextDecoder().decode(await open(seal1, `outbox:${p.id}`, new Uint8Array(await back.arrayBuffer())))).toContain('ready')
  })

  it('answers the team’s round in one request: joins, phones and what waits', async () => {
    const t = await setup()
    const p = await joined(t)
    await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(100))
    const sync = await (await t.asTeam('GET', `/v1/${MB}/sync`)).json() as { joins: unknown[]; devices: { id: string }[]; inbox: { device: string }[] }
    expect(sync.joins).toEqual([])
    expect(sync.devices.map((d) => d.id)).toEqual([p.id])
    expect(sync.inbox.map((e) => e.device)).toEqual([p.id])
    expect((await p.asPhone('GET', `/v1/${MB}/sync`)).status).toBe(404)
  })

  it('keeps large envelopes whole across chunks', async () => {
    const t = await setup()
    const p = await joined(t)
    const big = crypto.getRandomValues(new Uint8Array(65536))
    const body = new Uint8Array(LIMITS.chunk * 2 + 1000)
    for (let i = 0; i < body.length; i += big.length) body.set(big.subarray(0, Math.min(big.length, body.length - i)), i)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, body)).status).toBe(202)
    const [e] = await (await t.asTeam('GET', `/v1/${MB}/inbox`)).json() as { id: string }[]
    const got = new Uint8Array(await (await t.asTeam('GET', `/v1/${MB}/inbox/${e.id}`)).arrayBuffer())
    // Compared as bytes: a deep comparison of a megabyte takes seconds on a slow runner.
    expect(got.length).toBe(body.length)
    expect(Buffer.from(got).equals(Buffer.from(body))).toBe(true)
    expect([...t.store.data.keys()].filter((k) => k.startsWith(`chunk/${e.id}/`))).toHaveLength(3)
    await t.asTeam('DELETE', `/v1/${MB}/inbox/${e.id}`)
    expect([...t.store.data.keys()].filter((k) => k.startsWith('chunk/'))).toEqual([])
  })

  it('cannot open what it keeps: the envelope fails when sealed for another place or changed', async () => {
    const key = await phoneSealKey(randomKey())
    const sealed = await seal(key, 'inbox:a', new TextEncoder().encode('hello'))
    expect(await open(key, 'inbox:b', sealed)).toBeUndefined()
    const changed = sealed.slice()
    changed[20] ^= 1
    expect(await open(key, 'inbox:a', changed)).toBeUndefined()
    expect(await open(await phoneSealKey(randomKey()), 'inbox:a', sealed)).toBeUndefined()
    expect(new TextDecoder().decode(await open(key, 'inbox:a', sealed))).toBe('hello')
  })

  it('refuses strangers, wrong keys, old times and a nonce sent twice', async () => {
    const t = await setup()
    const p = await joined(t)
    expect((await t.signed('team', randomKey(), 'GET', `/v1/${MB}/inbox`)).status).toBe(401)
    expect((await t.signed(p.id, randomKey(), 'POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(401)
    expect((await t.signed('0'.repeat(32), p.sign, 'POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(401)
    // A phone's key is not the team's.
    expect((await t.signed('team', p.sign, 'GET', `/v1/${MB}/inbox`)).status).toBe(401)
    expect((await p.asPhone('GET', `/v1/${MB}/inbox`)).status).toBe(404)
    expect((await p.asPhone('GET', `/v1/${MB}/devices`)).status).toBe(404)
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/inbox`))).status).toBe(401)

    // A request that changes something, sent again, or one signed six minutes ago.
    const path = `/v1/${MB}/inbox`
    const time = String(t.now())
    const env = new TextEncoder().encode('e'.repeat(40))
    const sig = await requestSignature(p.sign, 'POST', path, time, 'replay-nonce-0001', env)
    const req = () => new Request(BASE + path, { method: 'POST', body: env, headers: { 'x-grndwrk-device': p.id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': 'replay-nonce-0001', 'x-grndwrk-signature': sig } })
    expect((await t.relay.handle(req())).status).toBe(202)
    expect((await t.relay.handle(req())).status).toBe(401)
    // A read sent again only reads again, and stores nothing.
    const get = await requestSignature(p.sign, 'GET', `/v1/${MB}/outbox`, time, 'read-nonce-000001', new Uint8Array())
    const read = () => new Request(`${BASE}/v1/${MB}/outbox`, { headers: { 'x-grndwrk-device': p.id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': 'read-nonce-000001', 'x-grndwrk-signature': get } })
    expect((await t.relay.handle(read())).status).toBe(204)
    expect((await t.relay.handle(read())).status).toBe(204)
    expect([...t.store.data.keys()].filter((k) => k.includes('read-nonce'))).toEqual([])
    t.tick(6 * 60_000)
    const sig2 = await requestSignature(p.sign, 'GET', `/v1/${MB}/outbox`, time, 'replay-nonce-0002', new Uint8Array())
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/outbox`, { headers: { 'x-grndwrk-device': p.id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': 'replay-nonce-0002', 'x-grndwrk-signature': sig2 } }))).status).toBe(401)
  })

  it('signs the body: a changed body is refused', async () => {
    const t = await setup()
    const p = await joined(t)
    const time = String(t.now())
    const sig = await requestSignature(p.sign, 'POST', `/v1/${MB}/inbox`, time, 'body-nonce-000001', new TextEncoder().encode('a'.repeat(40)))
    const res = await t.relay.handle(new Request(`${BASE}/v1/${MB}/inbox`, { method: 'POST', body: 'b'.repeat(40), headers: { 'x-grndwrk-device': p.id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': 'body-nonce-000001', 'x-grndwrk-signature': sig } }))
    expect(res.status).toBe(401)
  })

  it('lets an invite be used once, and not after it expires or is forgotten', async () => {
    const t = await setup()
    const inv = await inviteId(randomKey())
    const join = (id = inv) => t.relay.handle(new Request(`${BASE}/v1/${MB}/join/${id}`, { method: 'POST', body: 'x'.repeat(40) }))
    expect((await join()).status).toBe(404)
    await t.asTeam('POST', `/v1/${MB}/invites`, JSON.stringify({ id: inv, sealed: 'c2VhbGVk' }))
    expect((await join()).status).toBe(202)
    expect((await join()).status).toBe(409)
    await t.asTeam('DELETE', `/v1/${MB}/invites/${inv}`)
    expect((await join()).status).toBe(404)

    const inv2 = await inviteId(randomKey())
    await t.asTeam('POST', `/v1/${MB}/invites`, JSON.stringify({ id: inv2, sealed: 'c2VhbGVk' }))
    t.tick(LIMITS.invite + 1)
    expect((await join(inv2)).status).toBe(404)
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/join/${inv2}`, { method: 'POST', body: 'x'.repeat(LIMITS.join + 1) }))).status).toBe(413)
  })

  it('takes a phone out with everything it left', async () => {
    const t = await setup()
    const p = await joined(t)
    await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(100))
    await t.asTeam('PUT', `/v1/${MB}/outbox/${p.id}`, 'y'.repeat(100))
    const devices = await (await t.asTeam('GET', `/v1/${MB}/devices`)).json() as { id: string; sealed: string }[]
    expect(devices.map((d) => d.id)).toEqual([p.id])
    // A teammate's grndwrk opens the phone's key with the team key; the relay cannot.
    const key = await open(await teamSealKey(t.team), `device:${p.id}`, fromBase64(devices[0].sealed))
    expect(new TextDecoder().decode(key)).toBe(p.phoneKey)

    expect((await t.asTeam('DELETE', `/v1/${MB}/devices/${p.id}`)).status).toBe(200)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(100))).status).toBe(401)
    expect(await (await t.asTeam('GET', `/v1/${MB}/inbox`)).json()).toEqual([])
    expect([...t.store.data.keys()].filter((k) => /^(chunk|env|out|dev)\//.test(k))).toEqual([])
  })

  it('limits what a phone leaves in an hour, and the size of one envelope', async () => {
    const t = await setup()
    const p = await joined(t)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, new Uint8Array(LIMITS.body + 1))).status).toBe(413)
    for (let i = 0; i < LIMITS.perHour; i++) expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(202)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(429)
    t.tick(60 * 60_000)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(202)
    // And a day's worth, however it is spread over the hours.
    let sent = LIMITS.perHour + 1
    while (sent < LIMITS.perDay) {
      t.tick(60 * 60_000)
      for (let i = 0; i < LIMITS.perHour && sent < LIMITS.perDay; i++, sent++) expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(202)
    }
    // The clock started at noon UTC, and these hours stay within that day.
    t.tick(60 * 60_000)
    expect((await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(40))).status).toBe(429)
  })

  it('forgets envelopes nobody fetched in 30 days', async () => {
    const t = await setup()
    const p = await joined(t)
    await p.asPhone('POST', `/v1/${MB}/inbox`, 'x'.repeat(100))
    t.tick(LIMITS.keep + 60_000)
    expect(await (await t.asTeam('GET', `/v1/${MB}/inbox`)).json()).toEqual([])
    expect(await t.store.get('total')).toEqual({ n: 0, bytes: 0 })
  })

  it('opens a mailbox only for whoever deployed the relay, and checks the input it is given', async () => {
    const bare = new Relay(new MemoryStore(), undefined)
    expect((await bare.handle(new Request(`${BASE}/v1/hello`))).status).toBe(200)
    expect((await bare.handle(new Request(`${BASE}/v1/${'a'.repeat(32)}`, { method: 'PUT', body: '{}' }))).status).toBe(503)

    const t = await setup()
    const other = randomKey().slice(0, 32)
    // A team key, or a stranger, cannot open a mailbox; the owner cannot take over one that is open.
    expect((await t.signed('team', t.auth, 'PUT', `/v1/${other}`, JSON.stringify({ team: t.auth }))).status).toBe(401)
    expect((await t.signed('owner', randomKey(), 'PUT', `/v1/${other}`, JSON.stringify({ team: t.auth }))).status).toBe(401)
    expect((await t.asOwner('PUT', `/v1/${MB}`, JSON.stringify({ team: randomKey() }))).status).toBe(409)
    expect((await t.relay.handle(new Request(`${BASE}/v1/${other}/join/${'a'.repeat(32)}`, { method: 'POST', body: 'x'.repeat(40) }))).status).toBe(404)
    expect((await t.relay.handle(new Request(`${BASE}/v1/not-a-mailbox/inbox`))).status).toBe(404)
    // The owner key opens no mailbox's contents.
    expect((await t.signed('owner', t.owner, 'GET', `/v1/${MB}/inbox`)).status).toBe(401)

    expect((await t.asTeam('POST', `/v1/${MB}/invites`, '{"id":"../dev/x","sealed":""}')).status).toBe(400)
    expect((await t.asTeam('POST', `/v1/${MB}/invites`, JSON.stringify({ id: 'a'.repeat(32), sealed: '<script>' }))).status).toBe(400)
    // A link opened in a browser gets nothing from the relay: links are not its pages.
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/invite`))).status).toBe(401)
    expect((await t.asTeam('POST', `/v1/${MB}/invites`, 'not json')).status).toBe(400)
    expect((await t.asTeam('PUT', `/v1/${MB}/devices/${'a'.repeat(32)}`, JSON.stringify({ sign: 'short', sealed: '' }))).status).toBe(400)
    expect((await t.asTeam('PUT', `/v1/${MB}/outbox/${'a'.repeat(32)}`, 'x')).status).toBe(404)
    expect((await t.asTeam('GET', `/v1/${MB}/inbox/..%2Fdev`)).status).toBe(404)

    // Closing a full mailbox goes page by page, never all of it in memory at once.
    for (let i = 0; i < 300; i++) await t.store.put(`chunk/x${i}/0000`, new Uint8Array(10))
    expect((await t.asOwner('DELETE', `/v1/${MB}`)).status).toBe(200)
    expect(t.store.data.size).toBe(0)
    expect((await t.asTeam('GET', `/v1/${MB}/inbox`)).status).toBe(404)
  })

  it('keeps each project in its own mailbox: a key for one does nothing in another', async () => {
    const t = await setup()
    const a = MB
    const p = await joined(t)
    await p.asPhone('POST', `/v1/${a}/inbox`, 'x'.repeat(100))

    const b = randomKey().slice(0, 32)
    const teamB = await teamAuthKey(randomKey())
    expect((await t.asOwner('PUT', `/v1/${b}`, JSON.stringify({ team: teamB }))).status).toBe(200)
    // Project A's team and phone are strangers in B, and B sees nothing of A's.
    expect((await t.signed('team', t.auth, 'GET', `/v1/${b}/inbox`)).status).toBe(401)
    expect((await t.signed(p.id, p.sign, 'POST', `/v1/${b}/inbox`, 'x'.repeat(100))).status).toBe(401)
    expect(await (await t.signed('team', teamB, 'GET', `/v1/${b}/inbox`)).json()).toEqual([])
    // A request signed for A's path cannot be sent to B's.
    const time = String(t.now())
    const sig = await requestSignature(p.sign, 'POST', `/v1/${a}/inbox`, time, 'moved-nonce-00001', new TextEncoder().encode('x'.repeat(40)))
    const moved = await t.relay.handle(new Request(`${BASE}/v1/${b}/inbox`, { method: 'POST', body: 'x'.repeat(40), headers: { 'x-grndwrk-device': p.id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': 'moved-nonce-00001', 'x-grndwrk-signature': sig } }))
    expect(moved.status).toBe(401)
    expect(await (await t.signed('team', t.auth, 'GET', `/v1/${a}/inbox`)).json()).toHaveLength(1)
  })

  it('serves the Comment button only to the staging site the team named, set to run only there', async () => {
    const t = await setup()
    const script = (referer?: string) => t.relay.handle(new Request(`${BASE}/v1/${MB}/feedback.js`, { headers: referer ? { referer } : {} }))
    // No site yet: no button.
    expect((await script('https://staging.clinic.example/visits')).status).toBe(404)
    // Only the team names it, and only an https address.
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/site`, { method: 'PUT', body: JSON.stringify({ site: 'https://evil.example' }) }))).status).toBe(401)
    expect((await t.asTeam('PUT', `/v1/${MB}/site`, JSON.stringify({ site: 'http://staging.clinic.example' }))).status).toBe(400)
    expect((await t.asTeam('PUT', `/v1/${MB}/site`, JSON.stringify({ site: 'javascript:alert(1)' }))).status).toBe(400)
    const set = await t.asTeam('PUT', `/v1/${MB}/site`, JSON.stringify({ site: 'https://staging.clinic.example/any/path' }))
    expect(await set.json()).toEqual({ ok: true, site: 'https://staging.clinic.example' })
    expect((await (await t.asTeam('GET', `/v1/${MB}/sync`)).json()).site).toBe('https://staging.clinic.example')

    const ok = await script('https://staging.clinic.example/visits/3')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('javascript')
    const js = await ok.text()
    expect(js).toContain(`"site":"https://staging.clinic.example"`)
    expect(js).toContain(`"mailbox":"${MB}"`)
    expect(js.indexOf('through the relay')).toBeLessThan(js.indexOf('the button'))
    // A page on any other site gets nothing, production included.
    expect((await script('https://clinic.example/visits/3')).status).toBe(403)
    expect((await script('https://staging.clinic.example.evil.example/')).status).toBe(403)
    expect((await t.relay.handle(new Request(`${BASE}/v1/${MB}/screenshot.js`, { headers: { referer: 'https://staging.clinic.example/' } }))).status).toBe(200)

    // Off: no button, and its browsers are no longer answered.
    expect((await t.asTeam('PUT', `/v1/${MB}/site`, JSON.stringify({ site: '' }))).status).toBe(200)
    expect((await script('https://staging.clinic.example/')).status).toBe(404)
  })

  it('answers the staging site’s browsers on a phone’s paths only, and no other site', async () => {
    const t = await setup()
    await t.asTeam('PUT', `/v1/${MB}/site`, JSON.stringify({ site: 'https://staging.clinic.example' }))
    const preflight = (path: string, origin: string) =>
      t.relay.handle(new Request(`${BASE}/v1/${MB}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } }))
    const yes = await preflight('/inbox', 'https://staging.clinic.example')
    expect(yes.status).toBe(204)
    expect(yes.headers.get('access-control-allow-origin')).toBe('https://staging.clinic.example')
    expect(yes.headers.get('access-control-allow-headers')).toContain('x-grndwrk-signature')
    expect((await preflight('/join/' + 'a'.repeat(32), 'https://staging.clinic.example')).status).toBe(204)
    expect((await preflight('/inbox', 'https://clinic.example')).status).toBe(403)
    // The team's paths: never for a browser.
    for (const path of ['/sync', '/devices', '/invites', '/site', '/inbox/abc']) expect((await preflight(path, 'https://staging.clinic.example')).status).toBe(403)

    // The answer to its own request carries CORS for that site; for another site, or a team path, none.
    const unsigned = (path: string, origin: string, method = 'POST') => t.relay.handle(new Request(`${BASE}/v1/${MB}${path}`, { method, headers: { origin }, body: method === 'GET' ? undefined : 'x' }))
    expect((await unsigned('/inbox', 'https://staging.clinic.example')).headers.get('access-control-allow-origin')).toBe('https://staging.clinic.example')
    expect((await unsigned('/inbox', 'https://clinic.example')).headers.get('access-control-allow-origin')).toBeNull()
    expect((await unsigned('/sync', 'https://staging.clinic.example', 'GET')).headers.get('access-control-allow-origin')).toBeNull()
  })
})
