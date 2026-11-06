/**
 * The relay's cryptography, in WebCrypto so the same file runs in the
 * Worker, in grndwrk on Node, and in the tests. The iOS package does the
 * same in CryptoKit: keep the labels and the order of the lines identical.
 *
 * Keys are 64 hex characters. As in `--lan`, an HMAC is keyed by the key's
 * text (its UTF-8 bytes), not by the bytes the hex stands for.
 */

const enc = new TextEncoder()
/** WebCrypto's types want bytes on a plain ArrayBuffer; ours always are. */
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(text: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})*$/.test(text)) throw new Error('not hex')
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function randomKey(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : buf(data)))
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}

/** The same signature as `--lan` (src/server/devices.ts requestSignature). */
export async function requestSignature(key: string, method: string, path: string, time: string, nonce: string, body: Uint8Array): Promise<string> {
  return hmacHex(key, `grndwrk-request\n${method.toUpperCase()}\n${path}\n${time}\n${nonce}\n${await sha256Hex(body)}`)
}

/** Two keys from a phone's key: one the relay knows to check requests, one only the phone and the team know. */
export const phoneSignKey = (key: string) => hmacHex(key, 'grndwrk-relay:sign')
export const phoneSealKey = (key: string) => hmacHex(key, 'grndwrk-relay:seal')
/** What whoever deployed the relay signs in with, to open and close mailboxes. */
export const ownerAuthKey = (key: string) => hmacHex(key, 'grndwrk-relay:owner')
/** Two keys from the team key: the relay knows the first, never the second. */
export const teamAuthKey = (key: string) => hmacHex(key, 'grndwrk-relay:auth')
export const teamSealKey = (key: string) => hmacHex(key, 'grndwrk-relay:team-seal')
/** A device's id at the relay: from its signing key, as `--lan` does from its key. */
export const relayDeviceId = async (signKey: string) => (await sha256Hex(`grndwrk-device:${signKey}`)).slice(0, 32)
/** An invite's id at the relay: from its secret, so the relay never sees the secret. */
export const inviteId = async (secret: string) => (await sha256Hex(`grndwrk-invite:${secret}`)).slice(0, 32)

async function aesKey(key: string): Promise<CryptoKey> {
  const raw = fromHex(key)
  if (raw.length !== 32) throw new Error('a seal key is 32 bytes')
  return crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * AES-256-GCM: 12 random bytes, then the ciphertext and its tag. `context`
 * is bound in as additional data (`inbox:<device>`, `outbox:<device>`), so
 * the relay cannot move an envelope to another place without it failing.
 */
export async function seal(key: string, context: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, await aesKey(key), buf(plain)))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

/** The plain bytes, or undefined when the envelope was changed, is for another place, or another key sealed it. */
export async function open(key: string, context: string, sealed: Uint8Array): Promise<Uint8Array | undefined> {
  if (sealed.length < 12 + 16) return undefined
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: enc.encode(context) }, await aesKey(key), sealed.slice(12))
    return new Uint8Array(plain)
  } catch {
    return undefined
  }
}
