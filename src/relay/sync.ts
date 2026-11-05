/**
 * A project's grndwrk and its mailbox at the relay, while grndwrk runs: at
 * start and every 15 seconds it lets in phones that joined with an invite,
 * fetches what colleagues' phones left and handles each as if it came over
 * `--lan` (`via: relay`, `from:` their name), and leaves each phone the
 * status of its comments. Any teammate's grndwrk can do this: invites and
 * phones' keys are kept at the relay sealed with the team key.
 */
import { createHash } from 'node:crypto'
import { feedbackStatus } from '../server/feedback.js'
import { COMMENT_PATHS, commentRequest, type CommentsCtx } from '../server/comments.js'
import { inviteLink, type ProjectRelay } from './config.js'
import { RelayClient } from './client.js'
import { inviteId, open, openJson, phoneSealKey, phoneSignKey, randomKey, relayDeviceId, seal, sealJson, teamSealKey } from './keys.js'

interface Phone { key: string; name: string; joined: string }
export interface RelaySummary {
  url: string
  phones: { id: string; name: string; joined: string }[]
  invites: { id: string; name: string; expires: number }[]
  error?: string
}

const KEY = /^[a-f0-9]{64}$/
const EVERY = 15_000

export class RelaySync {
  private client: RelayClient
  private teamSeal: string
  private phones = new Map<string, Phone>()
  private sent = new Map<string, string>()
  private timer?: NodeJS.Timeout
  private running?: Promise<void>
  error?: string

  constructor(
    private relay: ProjectRelay,
    private ctx: CommentsCtx,
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
    await this.letIn()
    await this.loadPhones()
    await this.fetchInbox()
    await this.sendStatus()
  }

  /** Phones that joined with an invite: their key, sealed for the team, so every teammate's grndwrk can open their comments. */
  private async letIn() {
    const joins = await this.client.json<{ invite: string; sealed: string; body: string }[]>('GET', '/joins')
    for (const j of joins) {
      const inv = openJson<{ secret: string; name: string }>(this.teamSeal, `invite:${j.invite}`, j.sealed)
      const sent = inv && KEY.test(inv.secret) ? openJson<{ key?: string }>(inv.secret, `join:${j.invite}`, j.body) : undefined
      if (inv && sent?.key && KEY.test(sent.key)) {
        const sign = phoneSignKey(sent.key)
        const id = relayDeviceId(sign)
        const phone = { key: sent.key, name: inv.name, joined: new Date().toISOString().slice(0, 10) }
        await this.client.json('PUT', `/devices/${id}`, { sign, sealed: sealJson(this.teamSeal, `device:${id}`, phone) })
        this.phones.set(id, phone)
      }
      // Used, or not ours to open: either way the invite is done.
      await this.client.request('DELETE', `/invites/${j.invite}`)
    }
  }

  private async loadPhones() {
    const list = await this.client.json<{ id: string; sealed: string }[]>('GET', '/devices')
    this.phones = new Map(
      list.flatMap(({ id, sealed }) => {
        const p = openJson<Phone>(this.teamSeal, `device:${id}`, sealed)
        return p && KEY.test(p.key) ? [[id, p] as const] : []
      }),
    )
  }

  private async fetchInbox() {
    const list = await this.client.json<{ id: string; device: string }[]>('GET', '/inbox')
    for (const e of list) {
      const phone = this.phones.get(e.device)
      if (phone) {
        const raw = Buffer.from(await (await this.client.request('GET', `/inbox/${e.id}`)).arrayBuffer())
        const plain = open(phoneSealKey(phone.key), `inbox:${e.device}`, raw)
        await this.handle(plain, e.device, phone).catch((err) => console.error(`A comment from ${phone.name} through the relay: ${err instanceof Error ? err.message : err}`))
      }
      // Handled, or from a phone taken out, or changed on the way: it does not stay.
      await this.client.request('DELETE', `/inbox/${e.id}`)
    }
  }

  private async handle(plain: Buffer | undefined, device: string, phone: Phone) {
    if (!plain) throw new Error('it was changed on the way, or sealed with another key, and is dropped')
    const { path, body } = JSON.parse(plain.toString('utf8')) as { path?: unknown; body?: unknown }
    if (typeof path !== 'string' || !COMMENT_PATHS.includes(path) || path === '/api/feedback/status') throw new Error('not something a phone sends')
    await commentRequest(path, body, { ...this.ctx, via: 'relay', from: { name: phone.name, device } })
  }

  /** Each phone gets the status of its own comments, sealed with its key, when it changed. */
  private async sendStatus() {
    const nodes = await this.ctx.store.list()
    for (const [id, phone] of this.phones) {
      const own = nodes.filter((n) => n.extra?.relay_device === id && typeof n.extra?.key === 'string')
      const keys = new Map(own.map((n) => [n.id, String(n.extra.key)]))
      const status = await feedbackStatus(this.ctx.store, { comments: own.map((n) => ({ id: n.id, key: keys.get(n.id) })) })
      const payload = JSON.stringify({ comments: status.map((s) => ({ ...s, key: keys.get(s.id) })) })
      const hash = createHash('sha256').update(payload).digest('hex')
      if (this.sent.get(id) === hash) continue
      await this.client.request('PUT', `/outbox/${id}`, seal(phoneSealKey(phone.key), `outbox:${id}`, Buffer.from(payload)))
      this.sent.set(id, hash)
    }
  }

  /** A new invite for a colleague, by name: a link to send, or show as a QR code. Its secret and the name are sealed for the team. */
  async invite(name: string): Promise<{ id: string; name: string; link: string }> {
    const clean = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80)
    if (!clean) throw new Error('Say who the invite is for')
    const secret = randomKey()
    const id = inviteId(secret)
    await this.client.json('POST', '/invites', { id, sealed: sealJson(this.teamSeal, `invite:${id}`, { secret, name: clean }) })
    return { id, name: clean, link: inviteLink(this.relay, secret) }
  }

  async summary(): Promise<RelaySummary> {
    const out: RelaySummary = { url: this.relay.url, phones: [], invites: [], ...(this.error ? { error: this.error } : {}) }
    try {
      await this.loadPhones()
      const invites = await this.client.json<{ id: string; sealed: string; expires: number }[]>('GET', '/invites')
      out.invites = invites.flatMap((i) => {
        const v = openJson<{ name: string }>(this.teamSeal, `invite:${i.id}`, i.sealed)
        return v ? [{ id: i.id, name: v.name, expires: i.expires }] : []
      })
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err)
    }
    out.phones = [...this.phones].map(([id, p]) => ({ id, name: p.name, joined: p.joined }))
    return out
  }

  async removePhone(id: string) {
    await this.client.request('DELETE', `/devices/${id}`)
    this.phones.delete(id)
    this.sent.delete(id)
  }

  async removeInvite(id: string) {
    await this.client.request('DELETE', `/invites/${id}`)
  }
}
