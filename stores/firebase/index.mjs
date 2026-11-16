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
})

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
