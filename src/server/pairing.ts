import { createHash, randomBytes } from 'node:crypto'
import type { PairRequest, ServerEvent } from '../shared/types.js'
import { cleanText } from '../shared/text.js'

type Answer = 'allowed' | 'denied'

const WAIT = 3 * 60_000
/** Requests waiting at once, from all devices. Each device has at most one. */
const MAX_PENDING = 20

const words = (v: unknown, n: number) => (typeof v === 'string' ? cleanText(v).trim().slice(0, n) : '')

/** The four digits the phone and the map both show for a request: from the phone's secret, which only it and grndwrk know. */
export function checkDigits(secret: string): string {
  return String(parseInt(createHash('sha256').update(`grndwrk-pair:${secret}`).digest('hex').slice(0, 8), 16) % 10000).padStart(4, '0')
}
const validSecret = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(v) ? v : '')

/**
 * Pairing by asking: a phone on the network asks to send comments, the person
 * at the Mac allows it in the map, and the phone gets its own long key (see
 * devices.ts). The phone knows its request by a secret it made; the map only
 * ever sees a separate id, so nothing in the browser can be used to fetch the key.
 */
export class Pairings {
  private pending = new Map<string, PairRequest & { secret: string; ip: string; time: number }>()
  private answers = new Map<string, { answer: Answer; key?: string; time: number }>()

  constructor(
    /** Makes and keeps a key for an allowed phone. */
    private issue: (device: string) => Promise<string>,
    private onChange: (event: Extract<ServerEvent, { type: 'pair:request' | 'pair:done' }>) => void,
  ) {}

  /** A phone asks. One request per device at a time; a new one replaces its last. */
  ask(body: unknown, ip: string): PairRequest | null {
    this.expire()
    const b = (body ?? {}) as Record<string, unknown>
    const secret = validSecret(b.request)
    if (!secret) return null
    for (const [id, p] of this.pending) {
      if (p.secret === secret) return publicOf(p)
      if (p.ip === ip) this.drop(id)
    }
    if (this.pending.size >= MAX_PENDING) return null
    const request: PairRequest = {
      id: `pair_${randomBytes(6).toString('hex')}`,
      device: words(b.device, 60) || 'A phone',
      app: words(b.app, 60),
      at: new Date().toISOString(),
      from: ip.replace(/^::ffff:/, ''),
      check: checkDigits(secret),
    }
    this.pending.set(request.id, { ...request, secret, ip, time: Date.now() })
    this.onChange({ type: 'pair:request', request })
    return request
  }

  /** What became of a request, by the phone's secret. The key is told once, when allowed. */
  status(body: unknown): { status: 'waiting' | 'denied' | 'unknown' } | { status: 'allowed'; key: string } {
    this.expire()
    const secret = validSecret((body as Record<string, unknown> | null)?.request)
    const answered = secret ? this.answers.get(secret) : undefined
    if (answered) {
      this.answers.delete(secret)
      return answered.answer === 'allowed' && answered.key ? { status: 'allowed', key: answered.key } : { status: 'denied' }
    }
    return { status: secret && [...this.pending.values()].some((p) => p.secret === secret) ? 'waiting' : 'unknown' }
  }

  /** The person at the Mac answers. */
  async answer(id: string, allow: boolean): Promise<boolean> {
    const p = this.pending.get(id)
    if (!p) return false
    this.drop(id)
    this.answers.set(p.secret, allow ? { answer: 'allowed', key: await this.issue(p.device), time: Date.now() } : { answer: 'denied', time: Date.now() })
    return true
  }

  list(): PairRequest[] {
    this.expire()
    return [...this.pending.values()].map(publicOf)
  }

  private drop(id: string) {
    if (this.pending.delete(id)) this.onChange({ type: 'pair:done', id })
  }

  private expire() {
    const now = Date.now()
    for (const [id, p] of this.pending) if (now - p.time > WAIT) this.drop(id)
    for (const [secret, a] of this.answers) if (now - a.time > WAIT) this.answers.delete(secret)
  }
}

function publicOf(p: PairRequest): PairRequest {
  return { id: p.id, device: p.device, app: p.app, at: p.at, from: p.from, check: p.check }
}
