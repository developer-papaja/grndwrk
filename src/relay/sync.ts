/**
 * A project's grndwrk and its mailbox at the relay, while grndwrk runs: at
 * start and every 15 seconds, in one request, it sees phones that joined
 * with an invite (each waits until someone allows it in the map, with four
 * digits the phone shows too), fetches what colleagues' phones left and
 * handles each as if it came over `--lan` (`via: relay`, `from:` their
 * name), and leaves each phone the status of its comments. Any teammate's
 * grndwrk can do this: invites and phones' keys are kept at the relay
 * sealed with the team key.
 *
 * The relay cannot read or change an envelope, but it could hand an old one
 * over again. Each carries an id and a time from the phone, sealed in it:
 * one seen before, or older than the relay keeps anything, is refused.
 */
import { createHash } from 'node:crypto'
import { BadInput } from '../store/nodes.js'
import { feedbackStatus } from '../server/feedback.js'
import { COMMENT_PATHS, commentRequest, type CommentsCtx } from '../server/comments.js'
import { inviteLink, readSeen, saveSeen, siteOrigin, type ProjectRelay } from './config.js'
import { RelayClient } from './client.js'
import { inviteId, open, openJson, phoneSealKey, phoneSignKey, randomKey, relayDeviceId, seal, sealJson, teamSealKey } from './keys.js'

interface Phone { key: string; name: string; joined: string }
interface Waiting { invite: string; name: string; digits: string; key: string }
export interface RelaySummary {
  url: string
  phones: { id: string; name: string; joined: string }[]
  invites: { id: string; name: string; expires: number }[]
  /** Phones that joined with an invite and wait to be allowed, with the digits they show. */
  waiting: { invite: string; name: string; digits: string }[]
  /** The staging site colleagues may comment from, or ''. */
  site: string
  error?: string
}

const KEY = /^[a-f0-9]{64}$/
const EVERY = 15_000
const DAY = 86_400_000
/** As long as the relay keeps an envelope, and a day more. */
const FRESH = 31 * DAY

/** The four digits a phone shows after joining, worked out the same way on the phone from its key. */
export const joinDigits = (key: string) => String(parseInt(createHash('sha256').update(`grndwrk-join:${key}`).digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0')

export class RelaySync {
  private client: RelayClient
  private teamSeal: string
  private phones = new Map<string, Phone>()
  private waiting = new Map<string, Waiting>()
  private sent = new Map<string, string>()
  private tries = new Map<string, number>()
  /** The staging site the team named (`grndwrk relay site`), from the relay: a web comment's address must be on it. */
  private site = ''
  private timer?: NodeJS.Timeout
  private running?: Promise<void>
  error?: string

  constructor(
    private relay: ProjectRelay,
    private ctx: CommentsCtx,
    /** Told when a phone starts or stops waiting to be allowed, so the map can ask. */
    private onWaiting: () => void = () => {},
    client?: RelayClient,
  ) {
    this.client = client ?? RelayClient.team(relay.url, relay.mailbox, relay.team)
    this.teamSeal = teamSealKey(relay.team)
  }

  start() {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), EVERY)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  /** One round. Never two at once; a failure is kept to show in the map, and tried again next round. */
  tick(): Promise<void> {
    this.running ??= this.round()
      .then(() => {
        if (this.error) console.log('The relay answers again.')
        this.error = undefined
      })
      .catch((err) => {
        const said = err instanceof Error ? err.message : String(err)
        if (said !== this.error) console.error(`The relay: ${said}`)
        this.error = said
      })
      .finally(() => (this.running = undefined))
    return this.running
  }

  private async round() {
    const sync = await this.client.json<{
      joins: { invite: string; sealed: string; body: string }[]
      devices: { id: string; sealed: string }[]
      inbox: { id: string; device: string }[]
      site?: string
    }>('GET', '/sync')
    // The relay says which site: only an https origin is believed (it is shown in the map and checked against).
    this.site = typeof sync.site === 'string' ? siteOrigin(sync.site) : ''
    this.readJoins(sync.joins)
    this.readPhones(sync.devices)
    await this.fetchInbox(sync.inbox)
    await this.sendStatus()
  }

  /** Phones that joined: each waits for the person to allow it, never let in by the link alone. */
  private readJoins(joins: { invite: string; sealed: string; body: string }[]) {
    const next = new Map<string, Waiting>()
    for (const j of joins) {
      const inv = openJson<{ secret: string; name: string }>(this.teamSeal, `invite:${j.invite}`, j.sealed)
      const sent = inv && KEY.test(inv.secret) ? openJson<{ key?: string }>(inv.secret, `join:${j.invite}`, j.body) : undefined
      if (inv && sent?.key && KEY.test(sent.key)) next.set(j.invite, { invite: j.invite, name: inv.name, digits: joinDigits(sent.key), key: sent.key })
    }
    const changed = next.size !== this.waiting.size || [...next.keys()].some((k) => !this.waiting.has(k))
    this.waiting = next
    if (changed) this.onWaiting()
  }

  /** Allowed: the phone's key, sealed for the team, so every teammate's grndwrk can open its comments. Or not: the invite is gone. */
  async answerJoin(invite: string, allow: boolean): Promise<void> {
    const w = this.waiting.get(invite)
    if (!w) throw new BadInput('That phone is no longer waiting')
    if (allow) {
      const sign = phoneSignKey(w.key)
      const id = relayDeviceId(sign)
      const phone = { key: w.key, name: w.name, joined: new Date().toISOString().slice(0, 10) }
      await this.client.json('PUT', `/devices/${id}`, { sign, sealed: sealJson(this.teamSeal, `device:${id}`, phone) })
      this.phones.set(id, phone)
    }
    await this.client.request('DELETE', `/invites/${invite}`)
    this.waiting.delete(invite)
    this.onWaiting()
  }

  private readPhones(list: { id: string; sealed: string }[]) {
    this.phones = new Map(
      list.flatMap(({ id, sealed }) => {
        const p = openJson<Phone>(this.teamSeal, `device:${id}`, sealed)
        return p && KEY.test(p.key) ? [[id, p] as const] : []
      }),
    )
  }

  private async fetchInbox(list: { id: string; device: string }[]) {
    if (!list.length) return
    const seen = await readSeen(this.relay.mailbox)
    const now = Date.now()
    for (const e of list) {
      const phone = this.phones.get(e.device)
      let keep = false
      if (phone) {
        const raw = Buffer.from(await (await this.client.request('GET', `/inbox/${e.id}`)).arrayBuffer())
        try {
          await this.handle(open(phoneSealKey(phone.key), `inbox:${e.device}`, raw), e.device, phone, seen, now)
        } catch (err) {
          // Refused for good (changed, replayed, not a phone's request): dropped. Failed here (the disk?): tried again, five times.
          const forGood = err instanceof BadInput || err instanceof SyntaxError
          const tries = (this.tries.get(e.id) ?? 0) + 1
          keep = !forGood && tries < 5
          this.tries.set(e.id, tries)
          console.error(`A comment from ${phone.name} through the relay${keep ? ', tried again shortly' : ''}: ${err instanceof Error ? err.message : err}`)
        }
      }
      // Handled, or from a phone taken out, or refused: it does not stay.
      if (!keep) {
        await this.client.request('DELETE', `/inbox/${e.id}`)
        this.tries.delete(e.id)
      }
    }
    for (const [device, ids] of Object.entries(seen)) for (const [id, at] of Object.entries(ids)) if (now - at > FRESH) delete seen[device][id]
    await saveSeen(this.relay.mailbox, seen)
  }

  private async handle(plain: Buffer | undefined, device: string, phone: Phone, seen: Record<string, Record<string, number>>, now: number) {
    if (!plain) throw new BadInput('it was changed on the way, or sealed with another key, and is dropped')
    const { path, body, id, at } = JSON.parse(plain.toString('utf8')) as { path?: unknown; body?: unknown; id?: unknown; at?: unknown }
    if (typeof path !== 'string' || !COMMENT_PATHS.includes(path) || path === '/api/feedback/status') throw new BadInput('not something a phone sends')
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(id) || typeof at !== 'number') throw new BadInput('it has no id and time from the phone')
    if (seen[device]?.[id] || at < now - FRESH || at > now + 5 * 60_000) throw new BadInput('it was handled before, or is too old: the relay handed it over again')
    // A phone acts only on the comments it sent itself, whatever keys it knows.
    let own = path === '/api/feedback' ? this.onSite(body) : await this.onlyOwn(body, device)
    // A test result sealed before the fix was built is about an earlier fix: a relay handing an old one over again settles nothing.
    if (path === '/api/feedback/tested') own = await this.builtBefore(own, at)
    await commentRequest(path, own, { ...this.ctx, via: 'relay', from: { name: phone.name, device } })
    // Seen once handled, not before: one that failed for a passing reason stays at the relay and is tried again.
    ;(seen[device] ??= {})[id] = at
  }

  /**
   * A comment from a browser on the staging site says which page it was
   * made on. Only an address on that site is kept: the map links to it,
   * and testing would go there.
   */
  private onSite(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body
    const b = body as Record<string, unknown>
    if (typeof b.url !== 'string') return body
    let ok = false
    try {
      const u = new URL(b.url)
      ok = !!this.site && u.origin === this.site && !u.username && !u.password
    } catch {}
    if (ok) return body
    const { url: _drop, ...rest } = b
    return rest
  }

  private async builtBefore(body: unknown, at: number): Promise<unknown> {
    const list = (body as { comments?: unknown })?.comments
    if (!Array.isArray(list)) return body
    // A day of slack: built dates are written by the map (UTC) and by agents (their own day), so a genuine result is never dropped across time zones.
    const sealed = new Date(at + 86_400_000).toISOString().slice(0, 10)
    const built = new Map((await this.ctx.store.list()).map((n) => [n.id, typeof n.extra?.built === 'string' ? n.extra.built : '']))
    return { ...(body as object), comments: list.filter((c) => (built.get((c as { id?: unknown })?.id as string) ?? '') <= sealed) }
  }

  private async onlyOwn(body: unknown, device: string): Promise<unknown> {
    const list = (body as { comments?: unknown })?.comments
    if (!Array.isArray(list)) return body
    const mine = new Set((await this.ctx.store.list()).filter((n) => n.extra?.relay_device === device).map((n) => n.id))
    return { ...(body as object), comments: list.filter((c) => mine.has((c as { id?: unknown })?.id as string)) }
  }

  /** Each phone gets the status of its own comments, sealed with its key, when it changed, with the time it was made so an older one is ignored. */
  private async sendStatus() {
    const nodes = await this.ctx.store.list()
    for (const [id, phone] of this.phones) {
      const own = nodes.filter((n) => n.extra?.relay_device === id && typeof n.extra?.key === 'string')
      const keys = new Map(own.map((n) => [n.id, String(n.extra.key)]))
      const status = await feedbackStatus(this.ctx.store, { comments: own.map((n) => ({ id: n.id, key: keys.get(n.id) })) })
      const comments = status.map((s) => ({ ...s, key: keys.get(s.id) }))
      const hash = createHash('sha256').update(JSON.stringify(comments)).digest('hex')
      if (this.sent.get(id) === hash) continue
      const payload = JSON.stringify({ comments, at: Date.now() })
      await this.client.request('PUT', `/outbox/${id}`, seal(phoneSealKey(phone.key), `outbox:${id}`, Buffer.from(payload)))
      this.sent.set(id, hash)
    }
  }

  /** A new invite for a colleague, by name: a link to send, or show as a QR code. Its secret and the name are sealed for the team. */
  async invite(name: string): Promise<{ id: string; name: string; link: string }> {
    const clean = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80)
    if (!clean) throw new BadInput('Say who the invite is for')
    const secret = randomKey()
    const id = inviteId(secret)
    await this.client.json('POST', '/invites', { id, sealed: sealJson(this.teamSeal, `invite:${id}`, { secret, name: clean }) })
    return { id, name: clean, link: inviteLink(this.relay, secret) }
  }

  async summary(): Promise<RelaySummary> {
    const out: RelaySummary = { url: this.relay.url, phones: [], invites: [], waiting: [], site: this.site, ...(this.error ? { error: this.error } : {}) }
    try {
      const invites = await this.client.json<{ id: string; sealed: string; expires: number }[]>('GET', '/invites')
      out.invites = invites.flatMap((i) => {
        const v = openJson<{ name: string }>(this.teamSeal, `invite:${i.id}`, i.sealed)
        return v && !this.waiting.has(i.id) ? [{ id: i.id, name: v.name, expires: i.expires }] : []
      })
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err)
    }
    out.phones = [...this.phones].map(([id, p]) => ({ id, name: p.name, joined: p.joined }))
    out.waiting = [...this.waiting.values()].map(({ invite, name, digits }) => ({ invite, name, digits }))
    return out
  }

  async removePhone(id: string) {
    await this.client.request('DELETE', `/devices/${id}`)
    this.phones.delete(id)
    this.sent.delete(id)
  }

  async removeInvite(id: string) {
    await this.client.request('DELETE', `/invites/${id}`)
    this.waiting.delete(id)
  }
}
