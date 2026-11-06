/**
 * The relay's keys and sealing on Node: the same as relay/src/crypto.ts
 * (WebCrypto, for the Worker) and the iOS package (CryptoKit). A test checks
 * that each opens what the other sealed. Keys are 64 hex characters; an HMAC
 * is keyed by the key's text, as in `--lan`.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { requestSignature } from '../server/devices.js'

export const randomKey = () => randomBytes(32).toString('hex')
export const randomId = () => randomBytes(16).toString('hex')
const hmac = (key: string, message: string) => createHmac('sha256', key).update(message).digest('hex')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export const phoneSignKey = (key: string) => hmac(key, 'grndwrk-relay:sign')
export const phoneSealKey = (key: string) => hmac(key, 'grndwrk-relay:seal')
export const teamAuthKey = (key: string) => hmac(key, 'grndwrk-relay:auth')
export const teamSealKey = (key: string) => hmac(key, 'grndwrk-relay:team-seal')
export const ownerAuthKey = (key: string) => hmac(key, 'grndwrk-relay:owner')
export const relayDeviceId = (signKey: string) => sha(`grndwrk-device:${signKey}`).slice(0, 32)
export const inviteId = (secret: string) => sha(`grndwrk-invite:${secret}`).slice(0, 32)
export { requestSignature }

/** AES-256-GCM: 12 random bytes, the ciphertext, the 16-byte tag; `context` bound in as additional data. */
export function seal(key: string, context: string, plain: Buffer): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  c.setAAD(Buffer.from(context))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()])
}

/** The plain bytes, or undefined when it was changed, is for another place, or another key sealed it. */
export function open(key: string, context: string, sealed: Buffer): Buffer | undefined {
  if (sealed.length < 28) return undefined
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), sealed.subarray(0, 12))
    d.setAAD(Buffer.from(context))
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()])
  } catch {
    return undefined
  }
}

export const sealJson = (key: string, context: string, value: unknown) => seal(key, context, Buffer.from(JSON.stringify(value))).toString('base64')
export function openJson<T>(key: string, context: string, base64: string): T | undefined {
  const plain = open(key, context, Buffer.from(base64, 'base64'))
  if (!plain) return undefined
  try {
    return JSON.parse(plain.toString('utf8')) as T
  } catch {
    return undefined
  }
}
