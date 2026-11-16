// @ts-check
/**
 * Who may reach a map, run by whoever administers the Firebase project
 * (with the same credentials as the adapter: GOOGLE_APPLICATION_CREDENTIALS).
 *
 *   node members.mjs clinic add vet@example.com write
 *   node members.mjs clinic add dev_frontdesk1 comment --name "Front desk iPad"
 *   node members.mjs clinic key vet@example.com      prints a store key, once
 *   node members.mjs clinic remove vet@example.com   the member and its keys
 *   node members.mjs clinic list
 *   node members.mjs clinic site https://staging.vetclinic.example   (or off)
 *
 * A member is a Firebase Auth user (given by email or uid) or any id you
 * choose for a device that has no account, which then reaches the store
 * only with a key.
 */
import { randomBytes } from 'node:crypto'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { COMMENTER } from './adapter.mjs'
import { isHttpsOrigin, keyHash } from './functions.mjs'

const [map, action, who, role] = process.argv.slice(2)
const flag = (/** @type {string} */ name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
if (!map || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(map) || !['add', 'key', 'remove', 'list', 'site'].includes(action ?? '')) {
  console.error('Usage: node members.mjs <map> add|key|remove|list|site [email, id or site] [write|read|comment] [--name "..."] [--commenter id]')
  process.exit(1)
}

initializeApp({ credential: applicationDefault() })
const db = getFirestore()
/**
 * The account behind an email or an id. To add a member or make a key, the account must have proved
 * it owns the email: whoever signed up first with a colleague's address would get the colleague's role.
 * @param {string} w
 * @param {boolean} [verified]
 */
const uidOf = async (w, verified = true) => {
  if (!w.includes('@')) return w
  const user = await getAuth().getUserByEmail(w)
  if (verified && !user.emailVerified) throw new Error(`${w} has not verified that email yet. Ask them to verify it (or pass their user id) and try again`)
  return user.uid
}

if (action === 'site') {
  // The one staging site whose Comment button may call the store from the browser.
  if (who !== 'off' && !isHttpsOrigin(who ?? '')) throw new Error('The site is an https origin, like https://staging.vetclinic.example, or off')
  await db.doc(`projects/${map}`).set({ site: who === 'off' ? null : who }, { merge: true })
  console.log(who === 'off' ? 'No staging site may comment from the browser' : `${who} may send comments from the browser`)
} else if (action === 'list') {
  for (const d of (await db.collection(`projects/${map}/members`).get()).docs) console.log(d.id, JSON.stringify(d.data()))
} else if (!who) {
  console.error('Name the member: an email or an id')
  process.exit(1)
} else if (action === 'add') {
  if (!['write', 'read', 'comment'].includes(role ?? '')) throw new Error('The role is write, read or comment')
  const uid = await uidOf(who)
  const commenter = flag('commenter')
  if (role === 'comment' && !COMMENTER.test(commenter ?? uid)) throw new Error('A commenter id is 8 to 64 letters, digits, _ or -: pass --commenter')
  await db.doc(`projects/${map}/members/${uid}`).set({ role, ...(commenter ? { commenter } : {}), ...(flag('name') ? { name: flag('name') } : {}) })
  console.log(`${who} may ${role === 'comment' ? 'leave comments on' : role} ${map}`)
} else if (action === 'key') {
  const uid = await uidOf(who)
  // The map in front, so the store's root knows where to look it up (GET /v1/projects); the secret is the rest.
  const key = `gk_${map}.${randomBytes(32).toString('base64url')}`
  await db.doc(`projects/${map}/keys/${keyHash(key)}`).set({ uid, created: new Date().toISOString() })
  console.log(`A store key for ${who}. It is shown once; only its hash is kept.\n\n${key}\n`)
} else {
  const uid = await uidOf(who, false)
  await db.doc(`projects/${map}/members/${uid}`).delete()
  for (const d of (await db.collection(`projects/${map}/keys`).where('uid', '==', uid).get()).docs) await d.ref.delete()
  console.log(`${who} no longer reaches ${map}`)
}
