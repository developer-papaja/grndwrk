/**
 * The relay: a mailbox per project between colleagues' phones and the
 * team's grndwrk. It keeps sealed envelopes and checks who may leave and
 * take them. It cannot open them: the keys that seal them never reach it.
 *
 * Every path below is under the project's mailbox, `/v1/<mailbox>`, 32 hex
 * characters, and each mailbox has its own storage, keys and limits.
 *
 * Whoever deployed the relay (signed as `owner` with OWNER_AUTH):
 *   PUT    /v1/<mailbox> {team}  open a mailbox for a project, with its team's auth key
 *   DELETE /v1/<mailbox>         close it, with everything in it
 * The phone (signed with its signing key, which the team registered):
 *   POST /v1/inbox            leave an envelope (at most 4 MB)
 *   GET  /v1/outbox           the sealed status of its comments, or 204
 * A phone joining with an invite (not signed: it has no key here yet):
 *   POST /v1/join/<invite>    its key, sealed with the invite's secret, once
 * The project's team (signed as `team` with the mailbox's auth key):
 *   POST   /v1/invites {id, sealed}  an invite a phone may join with, for 7 days;
 *                             `sealed` (its secret and the colleague's name) only the team opens
 *   GET    /v1/invites        the open invites
 *   DELETE /v1/invites/<id>   forget it, and what a phone left with it
 *   GET    /v1/joins          the phones waiting to be let in, with their invite's sealed part
 *   PUT    /v1/devices/<id> {sign, sealed}   let a phone in
 *   GET    /v1/devices        the phones, with their keys sealed for the team
 *   DELETE /v1/devices/<id>   take a phone out, with all it left
 *   GET    /v1/inbox          the envelopes waiting, oldest first
 *   GET    /v1/inbox/<id>     one envelope; DELETE it once handled
 *   PUT    /v1/outbox/<device>  the sealed status for a phone
 * Anyone: GET /v1/hello, and GET /v1/<mailbox>/invite or /team: a page
 * saying what to do with an invite or a team link (the secret stays in
 * the link's #fragment, which a browser never sends).
 *
 * Kept separate from Cloudflare (worker.ts) so the tests run it on Node.
 */
import { requestSignature } from './crypto.js'

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<unknown>
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>
}

interface Device { sign: string; sealed: string; added: number }
interface Envelope { device: string; at: number; size: number; chunks: number }
interface Rate { hour: number; n: number; bytes: number }
interface Invite { expires: number; sealed: string }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const LIMITS = {
  skew: 5 * MINUTE,
  body: 4 * 1024 * 1024,
  chunk: 512 * 1024,
  outbox: 512 * 1024,
  join: 16 * 1024,
  sealedKey: 4 * 1024,
  perHour: 120,
  bytesPerHour: 200 * 1024 * 1024,
  waiting: 1000,
  waitingBytes: 1024 * 1024 * 1024,
  keep: 30 * DAY,
  invite: 7 * DAY,
  invites: 50,
  devices: 200,
  list: 100,
}

const ID = /^[a-f0-9]{32}$/
const KEY = /^[a-f0-9]{64}$/
const ENVELOPE = /^[a-z0-9]{10}-[a-z0-9]{8}$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const fail = (status: number, error: string) => json({ error }, status)
const bytes = (data: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(data as BodyInit, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...headers } })

export class Relay {
  constructor(
    private store: Store,
    /** The owner's auth key (64 hex), set as a secret when the relay is deployed. Only it opens mailboxes. */
    private ownerAuth: string | undefined,
    private now: () => number = Date.now,
  ) {}

  async handle(req: Request): Promise<Response> {
    try {
      return await this.route(req)
    } catch (e) {
      if (e instanceof Response) return e
      return fail(500, 'The relay failed')
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method.toUpperCase()
    const all = path.split('/').filter(Boolean)
    if (all[0] !== 'v1') return fail(404, 'Not found')
    if (method === 'GET' && path === '/v1/hello') return json({ relay: 'grndwrk', version: 2 })
    const mailbox = all[1] ?? ''
    if (!ID.test(mailbox)) return fail(404, 'Not found')
    // From here on as if the mailbox were the root: [mailbox, what, id].
    const parts = all.slice(1)
    const rest = parts.slice(1).join('/')

    if (!rest) {
      if (!this.ownerAuth || !KEY.test(this.ownerAuth)) return fail(503, 'The relay is not set up: it has no owner key')
      const body = await this.body(req, LIMITS.join)
      if ((await this.verify(req, method, path + url.search, body, { owner: this.ownerAuth })) !== 'owner') return fail(401, 'Only whoever deployed the relay opens or closes a mailbox')
      return this.owner(method, body)
    }

    if (method === 'GET' && (rest === 'invite' || rest === 'team')) return page(rest)

    const teamAuth = await this.store.get<string>('team')
    if (!teamAuth) return fail(404, 'No such mailbox')
    await this.sweep()

    if (method === 'POST' && parts[1] === 'join' && parts.length === 3) {
      const body = await this.body(req, LIMITS.join)
      return this.join(parts[2], body)
    }

    const body = await this.body(req, LIMITS.body)
    const who = await this.verify(req, method, path + url.search, body, { team: teamAuth })
    if (!who) return fail(401, 'Not signed by a phone or a team this mailbox knows')

    if (who === 'team') return this.team(method, parts, body)
    if (method === 'POST' && rest === 'inbox') return this.leave(who, body)
    if (method === 'GET' && rest === 'outbox') {
      const out = await this.store.get<Uint8Array>(`out/${who}`)
      return out ? bytes(out) : new Response(null, { status: 204 })
    }
    return fail(404, 'Not found')
  }

  /** Open a mailbox with its team's auth key, once; or close it with everything in it. */
  private async owner(method: string, body: Uint8Array): Promise<Response> {
    if (method === 'PUT') {
      const { team } = this.parse(body)
      if (typeof team !== 'string' || !KEY.test(team)) return fail(400, 'A team key is 64 hex characters')
      const had = await this.store.get<string>('team')
      if (had && had !== team) return fail(409, 'This mailbox is open for another team')
      await this.store.put('team', team)
      return json({ ok: true })
    }
    if (method === 'DELETE') {
      const keys = [...(await this.store.list({ prefix: '' })).keys()]
      for (let i = 0; i < keys.length; i += 128) await this.store.delete(keys.slice(i, i + 128))
      return json({ ok: true })
    }
    return fail(404, 'Not found')
  }

  private async team(method: string, parts: string[], body: Uint8Array): Promise<Response> {
    const [, what, id] = parts
    const one = parts.length === 3
    if (what === 'invites' && method === 'POST' && parts.length === 2) {
      const { id: inv, sealed } = this.parse(body)
      if (typeof inv !== 'string' || !ID.test(inv)) return fail(400, 'An invite id is 32 hex characters')
      if (typeof sealed !== 'string' || !B64.test(sealed) || sealed.length > LIMITS.sealedKey) return fail(400, 'The sealed part is base64, at most 4 KB')
      const open = await this.store.list({ prefix: 'inv/' })
      if (open.size >= LIMITS.invites && !open.has(`inv/${inv}`)) return fail(429, 'Too many open invites')
      await this.store.put(`inv/${inv}`, { expires: this.now() + LIMITS.invite, sealed } satisfies Invite)
      return json({ ok: true })
    }
    if (what === 'invites' && method === 'GET' && parts.length === 2) {
      const invs = await this.store.list<Invite>({ prefix: 'inv/' })
      return json([...invs].filter(([, v]) => v.expires >= this.now()).map(([k, v]) => ({ id: k.slice(4), sealed: v.sealed, expires: v.expires })))
    }
    if (what === 'invites' && method === 'DELETE' && one && ID.test(id)) {
      await this.store.delete([`inv/${id}`, `join/${id}`])
      return json({ ok: true })
    }
    if (what === 'joins' && method === 'GET' && parts.length === 2) {
      const joins = await this.store.list<Uint8Array>({ prefix: 'join/' })
      const out = []
      for (const [k, v] of joins) {
        const inv = await this.store.get<Invite>(`inv/${k.slice(5)}`)
        if (inv) out.push({ invite: k.slice(5), sealed: inv.sealed, body: toBase64(v) })
      }
      return json(out)
    }
    if (what === 'devices' && method === 'PUT' && one && ID.test(id)) {
      const { sign, sealed } = this.parse(body)
      if (typeof sign !== 'string' || !KEY.test(sign)) return fail(400, 'A signing key is 64 hex characters')
      if (typeof sealed !== 'string' || !B64.test(sealed) || sealed.length > LIMITS.sealedKey) return fail(400, 'The sealed key is base64, at most 4 KB')
      const old = await this.store.get<Device>(`dev/${id}`)
      if (!old && (await this.store.list({ prefix: 'dev/' })).size >= LIMITS.devices) return fail(429, 'Too many phones')
      await this.store.put(`dev/${id}`, { sign, sealed, added: old?.added ?? this.now() } satisfies Device)
      return json({ ok: true })
    }
    if (what === 'devices' && method === 'GET' && parts.length === 2) {
      const devs = await this.store.list<Device>({ prefix: 'dev/' })
      return json([...devs].map(([k, d]) => ({ id: k.slice(4), sealed: d.sealed, added: d.added })))
    }
    if (what === 'devices' && method === 'DELETE' && one && ID.test(id)) {
      await this.store.delete([`dev/${id}`, `out/${id}`, `rate/${id}`])
      for (const [k, e] of await this.store.list<Envelope>({ prefix: 'env/' })) if (e.device === id) await this.drop(k.slice(4), e)
      return json({ ok: true })
    }
    if (what === 'inbox' && method === 'GET' && parts.length === 2) {
      const envs = await this.store.list<Envelope>({ prefix: 'env/', limit: LIMITS.list })
      return json([...envs].map(([k, e]) => ({ id: k.slice(4), device: e.device, at: e.at, size: e.size })))
    }
    if (what === 'inbox' && one && ENVELOPE.test(id) && (method === 'GET' || method === 'DELETE')) {
      const e = await this.store.get<Envelope>(`env/${id}`)
      if (!e) return fail(404, 'No such envelope')
      if (method === 'DELETE') {
        await this.drop(id, e)
        return json({ ok: true })
      }
      const chunks = await this.store.list<Uint8Array>({ prefix: `chunk/${id}/` })
      const out = new Uint8Array(e.size)
      let at = 0
      for (let n = 0; n < e.chunks; n++) {
        const c = chunks.get(`chunk/${id}/${String(n).padStart(4, '0')}`)
        if (!c) return fail(500, 'The envelope is incomplete')
        out.set(c, at)
        at += c.length
      }
      return bytes(out, { 'x-grndwrk-from': e.device })
    }
    if (what === 'outbox' && method === 'PUT' && one && ID.test(id)) {
      if (body.length > LIMITS.outbox) return fail(413, 'At most 512 KB')
      if (!(await this.store.get(`dev/${id}`))) return fail(404, 'No such phone')
      await this.store.put(`out/${id}`, body)
      return json({ ok: true })
    }
    return fail(404, 'Not found')
  }

  /** A phone leaves its key, sealed with the invite's secret. The first one counts; the invite is then used. */
  private async join(invite: string, body: Uint8Array): Promise<Response> {
    if (!ID.test(invite)) return fail(404, 'No such invite')
    const inv = await this.store.get<Invite>(`inv/${invite}`)
    if (!inv || inv.expires < this.now()) return fail(404, 'No such invite, or it has expired')
    if (await this.store.get(`join/${invite}`)) return fail(409, 'This invite has been used')
    if (body.length < 28) return fail(400, 'Empty')
    await this.store.put(`join/${invite}`, body)
    return json({ ok: true }, 202)
  }

  /** A phone leaves an envelope, within its limits and the relay's. */
  private async leave(device: string, body: Uint8Array): Promise<Response> {
    if (body.length < 28) return fail(400, 'Empty')
    const now = this.now()
    const hour = Math.floor(now / HOUR)
    const rate = (await this.store.get<Rate>(`rate/${device}`)) ?? { hour, n: 0, bytes: 0 }
    if (rate.hour !== hour) Object.assign(rate, { hour, n: 0, bytes: 0 })
    if (rate.n >= LIMITS.perHour || rate.bytes + body.length > LIMITS.bytesPerHour) return fail(429, 'Too much from this phone this hour')
    const total = (await this.store.get<{ n: number; bytes: number }>('total')) ?? { n: 0, bytes: 0 }
    if (total.n >= LIMITS.waiting || total.bytes + body.length > LIMITS.waitingBytes) return fail(507, 'The relay is full until the team fetches')

    const id = `${now.toString(36).padStart(10, '0')}-${randomName()}`
    const chunks = Math.max(1, Math.ceil(body.length / LIMITS.chunk))
    for (let n = 0; n < chunks; n++) await this.store.put(`chunk/${id}/${String(n).padStart(4, '0')}`, body.slice(n * LIMITS.chunk, (n + 1) * LIMITS.chunk))
    await this.store.put(`env/${id}`, { device, at: now, size: body.length, chunks } satisfies Envelope)
    await this.store.put(`rate/${device}`, { hour, n: rate.n + 1, bytes: rate.bytes + body.length } satisfies Rate)
    await this.store.put('total', { n: total.n + 1, bytes: total.bytes + body.length })
    return json({ id }, 202)
  }

  private async drop(id: string, e: Envelope): Promise<void> {
    const keys = [`env/${id}`]
    for (let n = 0; n < e.chunks; n++) keys.push(`chunk/${id}/${String(n).padStart(4, '0')}`)
    await this.store.delete(keys)
    const total = (await this.store.get<{ n: number; bytes: number }>('total')) ?? { n: 0, bytes: 0 }
    await this.store.put('total', { n: Math.max(0, total.n - 1), bytes: Math.max(0, total.bytes - e.size) })
  }

  /** `owner`, `team`, a known phone's id, or undefined. A nonce counts once; the time must be within five minutes. */
  private async verify(req: Request, method: string, path: string, body: Uint8Array, may: { owner?: string; team?: string }): Promise<string | undefined> {
    const h = (name: string) => req.headers.get(name) ?? ''
    const id = h('x-grndwrk-device')
    const time = Number(h('x-grndwrk-time'))
    const nonce = h('x-grndwrk-nonce')
    const signature = h('x-grndwrk-signature')
    const now = this.now()
    if (!Number.isFinite(time) || Math.abs(now - time) > LIMITS.skew) return undefined
    if (!/^[A-Za-z0-9-]{16,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return undefined
    let key: string | undefined
    if (id === 'owner') key = may.owner
    else if (id === 'team') key = may.team
    else if (ID.test(id) && may.team) key = (await this.store.get<Device>(`dev/${id}`))?.sign
    if (!key) return undefined
    const want = await requestSignature(key, method, path, String(time), nonce, body)
    if (!sameText(want, signature)) return undefined
    if (await this.store.get(`nonce/${id}/${nonce}`)) return undefined
    await this.store.put(`nonce/${id}/${nonce}`, now)
    return id
  }

  private async body(req: Request, max: number): Promise<Uint8Array> {
    const said = Number(req.headers.get('content-length') ?? 0)
    if (said > max) throw fail(413, 'Too large')
    const body = new Uint8Array(await req.arrayBuffer())
    if (body.length > max) throw fail(413, 'Too large')
    return body
  }

  private parse(body: Uint8Array): Record<string, unknown> {
    try {
      const v = JSON.parse(new TextDecoder().decode(body))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {}
    throw fail(400, 'Expected a JSON object')
  }

  /** Every ten minutes at most: forget old nonces, expired invites and envelopes nobody fetched in 30 days. */
  private async sweep(): Promise<void> {
    const now = this.now()
    const last = (await this.store.get<number>('swept')) ?? 0
    if (now - last < 10 * MINUTE) return
    await this.store.put('swept', now)
    const old: string[] = []
    for (const [k, at] of await this.store.list<number>({ prefix: 'nonce/' })) if (now - at > 2 * LIMITS.skew) old.push(k)
    for (const [k, inv] of await this.store.list<{ expires: number }>({ prefix: 'inv/' })) if (inv.expires < now) old.push(k, `join/${k.slice(4)}`)
    for (let i = 0; i < old.length; i += 128) await this.store.delete(old.slice(i, i + 128))
    let n = 0
    let size = 0
    for (const [k, e] of await this.store.list<Envelope>({ prefix: 'env/' })) {
      if (now - e.at > LIMITS.keep) await this.drop(k.slice(4), e)
      else (n++, (size += e.size))
    }
    await this.store.put('total', { n, bytes: size })
  }
}

/** What a browser shows for an invite or a team link opened by mistake. No script, nothing from elsewhere. */
function page(kind: 'invite' | 'team'): Response {
  const say = kind === 'invite'
    ? ['An invite to send comments with grndwrk', 'Open the app you test on your phone, long press the grndwrk button, choose Join with an invite, and paste this link. Or scan the QR code you were sent.']
    : ['A team link for grndwrk', 'In the project, run <code>grndwrk relay join</code> followed by this whole link. It connects your grndwrk to the team\'s relay.']
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${say[0]}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#eee;padding:0 .2em}</style><h1 style="font-size:1.3rem">${say[0]}</h1><p>${say[1]}</p>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer' } })
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

function randomName(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => abc[b % 36]).join('')
}

export function toBase64(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}
