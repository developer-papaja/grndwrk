import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readFile, rename, writeFile } from '../store/fs.js'
import { keepOutOfGit } from '../store/gitignore.js'

/**
 * Phones paired with `--lan`. Each gets a long random key when it is
 * allowed (or once it typed the pairing code), kept here and on the phone,
 * never sent again: the hello proof and every request are signed with it.
 * The short code is only typed in, and only guessable online, where wrong
 * tries lock out. A recorded hello or request lets nobody guess the key,
 * and a fake grndwrk relaying a phone's requests learns nothing it can use.
 * Kept in `.grndwrk/lan-devices.json`, out of git. Delete it to unpair every phone.
 */
export interface Device {
  /** What the phone sends to say which key it signs with: a hash of the key, so it gives the key away to nobody. */
  id: string
  key: string
  name: string
  paired: string
}

/** How far a request's time may be from this Mac's clock. */
const SKEW = 5 * 60_000

export class Devices {
  private devices: Device[] = []
  /** Nonces seen recently, so a recorded request cannot be sent again. */
  private seen = new Map<string, number>()

  constructor(private gwDir: string) {}

  private get file() {
    return join(this.gwDir, 'lan-devices.json')
  }

  async load(): Promise<this> {
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8'))
      this.devices = Array.isArray(list) ? list.filter((d): d is Device => typeof d?.key === 'string' && /^[a-f0-9]{64}$/.test(d.key)).map((d) => ({ ...d, id: deviceId(d.key) })) : []
    } catch {
      this.devices = []
    }
    return this
  }

  /** A newly allowed phone: its key, told to it once. */
  async add(name: string): Promise<string> {
    const key = randomBytes(32).toString('hex')
    this.devices.push({ id: deviceId(key), key, name, paired: new Date().toISOString().slice(0, 10) })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.devices, null, 1) + '\n', { mode: 0o600 })
    await rename(tmp, this.file)
    await keepOutOfGit(this.gwDir, 'lan-devices.json')
    return key
  }

  byId(id: unknown): Device | undefined {
    return typeof id === 'string' ? this.devices.find((d) => d.id === id) : undefined
  }

  /** The proof for a phone's challenge, or none when the phone is not known here. */
  proof(id: unknown, challenge: string): string | undefined {
    const d = this.byId(id)
    return d && /^[A-Za-z0-9-]{16,64}$/.test(challenge) ? helloProof(d.key, challenge) : undefined
  }

  /**
   * The device a signed request comes from, or why it is refused. The
   * signature covers the method, path, time, a nonce and the body, so it can
   * be neither changed nor sent again.
   */
  verify(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: Buffer, now = Date.now()): Device | 'unsigned' | 'refused' {
    const h = (name: string) => (typeof headers[name] === 'string' ? (headers[name] as string) : '')
    const id = h('x-grndwrk-device')
    const signature = h('x-grndwrk-signature')
    if (!id && !signature) return 'unsigned'
    const d = this.byId(id)
    const time = Number(h('x-grndwrk-time'))
    const nonce = h('x-grndwrk-nonce')
    if (!d || !Number.isFinite(time) || Math.abs(now - time) > SKEW || !/^[A-Za-z0-9-]{16,64}$/.test(nonce)) return 'refused'
    const want = Buffer.from(requestSignature(d.key, method, path, String(time), nonce, body), 'hex')
    const got = Buffer.from(/^[a-f0-9]{64}$/.test(signature) ? signature : '', 'hex')
    if (got.length !== want.length || !timingSafeEqual(got, want)) return 'refused'
    for (const [n, at] of this.seen) if (now - at > 2 * SKEW) this.seen.delete(n)
    if (this.seen.has(`${id}:${nonce}`)) return 'refused'
    this.seen.set(`${id}:${nonce}`, now)
    return d
  }
}

export function deviceId(key: string): string {
  return createHash('sha256').update(`grndwrk-device:${key}`).digest('hex').slice(0, 32)
}

/** HMAC-SHA256 of the challenge, keyed by the device's key, as hex. The phone works out the same. */
export function helloProof(key: string, challenge: string): string {
  return createHmac('sha256', key).update(`grndwrk-hello:${challenge}`).digest('hex')
}

/** What a phone signs a request with. The same lines, in the same order, in Connection.swift. */
export function requestSignature(key: string, method: string, path: string, time: string, nonce: string, body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('hex')
  return createHmac('sha256', key).update(`grndwrk-request\n${method.toUpperCase()}\n${path}\n${time}\n${nonce}\n${hash}`).digest('hex')
}
