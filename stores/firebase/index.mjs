// @ts-check
/**
 * The Cloud Function: firebase-admin and firebase-functions around
 * functions.mjs. Kept this thin because only a Firebase project (or the
 * emulator) runs it; everything it calls is tested on Node.
 */
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { onRequest } from 'firebase-functions/https'
import { readFile } from 'node:fs/promises'
import { firebaseBackend } from './adapter.mjs'
import { storeFunction } from './functions.mjs'

initializeApp()

const handle = storeFunction({
  backend: firebaseBackend(getFirestore(), () => getStorage().bucket()),
  // checkRevoked: a member signed out everywhere (or disabled) is refused at once.
  verify: async (token) => ({ uid: (await getAuth().verifyIdToken(token, true)).uid }),
  // The page and the Comment button: the folder `grndwrk store assets page` wrote here, deployed with the function.
  page: (name) => readFile(new URL(`./page/${name}`, import.meta.url)).catch(() => null),
  // The store's own address, as the staging site and the page reach it: the function's address
  // (or your Hosting address), ending in /. Set in .env next to this file. Never taken from a request.
  baseUrl: process.env.GRNDWRK_STORE_URL,
  // Optional: what one comment token may leave (adapter.mjs, INBOX_LIMITS).
  limits: limitsFromEnv(process.env),
})

/**
 * The inbox limits the environment changes: INBOX_FILES_PER_HOUR, INBOX_MB_PER_HOUR, INBOX_WAITING, INBOX_TOTAL.
 * @param {Record<string, string | undefined>} env
 */
function limitsFromEnv(env) {
  const n = (/** @type {string | undefined} */ v) => (v && /^\d{1,12}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined)
  /** @type {Partial<import('./adapter.mjs').InboxLimits>} */
  const out = {}
  if (n(env.INBOX_FILES_PER_HOUR)) out.filesPerHour = n(env.INBOX_FILES_PER_HOUR)
  if (n(env.INBOX_MB_PER_HOUR)) out.bytesPerHour = Number(n(env.INBOX_MB_PER_HOUR)) * 1_000_000
  if (n(env.INBOX_WAITING)) out.waiting = n(env.INBOX_WAITING)
  if (n(env.INBOX_TOTAL)) out.total = n(env.INBOX_TOTAL)
  return out
}

// https://<region>-<firebase project>.cloudfunctions.net/store/<map>/ is the address grndwrk is given.
// Pick the region your Firestore is in.
export const store = onRequest({ region: 'europe-west1', invoker: 'public', memory: '512MiB', timeoutSeconds: 60 }, async (req, res) => {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  // Cloud Functions has read and parsed the body already; rawBody is its bytes as sent.
  const body = req.method === 'PUT' && req.rawBody ? new Uint8Array(req.rawBody) : undefined
  const answer = await handle(new Request(`https://store${req.originalUrl}`, { method: req.method, headers, body }))
  res.status(answer.status)
  answer.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  res.end(Buffer.from(await answer.arrayBuffer()))
})
