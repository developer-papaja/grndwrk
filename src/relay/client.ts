/**
 * Talking to the relay as a project's team, or as its owner. Every request
 * is signed like a phone's on `--lan`; see relay/src/relay.ts for the paths.
 */
import { randomBytes } from 'node:crypto'
import { ownerAuthKey, requestSignature, teamAuthKey } from './keys.js'

export class RelayError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export class RelayClient {
  constructor(
    private url: string,
    private mailbox: string,
    private signer: { id: 'team' | 'owner'; key: string },
  ) {}

  static team(url: string, mailbox: string, teamKey: string) {
    return new RelayClient(url, mailbox, { id: 'team', key: teamAuthKey(teamKey) })
  }
  static owner(url: string, mailbox: string, ownerKey: string) {
    return new RelayClient(url, mailbox, { id: 'owner', key: ownerAuthKey(ownerKey) })
  }

  async request(method: string, rest: string, body?: Buffer | object): Promise<Response> {
    const path = `/v1/${this.mailbox}${rest}`
    const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const time = String(Date.now())
    const nonce = randomBytes(16).toString('hex')
    const res = await fetch(this.url + path, {
      method,
      body: method === 'GET' ? undefined : new Uint8Array(data),
      headers: {
        'x-grndwrk-device': this.signer.id,
        'x-grndwrk-time': time,
        'x-grndwrk-nonce': nonce,
        'x-grndwrk-signature': requestSignature(this.signer.key, method, path, time, nonce, data),
        'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok && res.status !== 204) {
      const said = await res.json().then((j: { error?: unknown }) => j.error, () => undefined)
      // Printed in the terminal: never control characters from the relay (they could drive the terminal).
      const clean = typeof said === 'string' ? said.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 200) : ''
      throw new RelayError(res.status, clean || `The relay answered ${res.status}`)
    }
    return res
  }

  json<T>(method: string, rest: string, body?: object): Promise<T> {
    return this.request(method, rest, body).then((r) => r.json() as Promise<T>)
  }
}
