// @ts-check
/**
 * A grndwrk store on Firebase: the map's files in Firestore, the large ones
 * in Cloud Storage. This file is both the adapter grndwrk loads
 * (`.grndwrk/store.json`: `{ "adapter": "tools/grndwrk-firebase/adapter.mjs" }`)
 * and the store logic the Cloud Function in index.mjs answers HTTP with.
 *
 * It holds everything it runs apart from firebase-admin itself: grndwrk
 * allows an adapter by the hash of this one file, so code in a file it
 * imported would change unseen.
 *
 * Layout (docs: README.md):
 *   projects/{map}                 { name?, counter, inbox?, floor? }   inbox: files waiting there
 *   projects/{map}/files/{key}     { path, version, type, size, at, data? | blob? }
 *   projects/{map}/changes/{key}   { path, at, version? , deleted }
 *   projects/{map}/members/{uid}   { role, commenter?, name? }   (read by the function only)
 *   projects/{map}/keys/{sha256}   { uid }                       (read by the function only)
 *   projects/{map}/commenters/{id} { waiting, recent: [{ at, size }] }   for the inbox limits
 *   Storage: projects/{map}/blobs/{random}, one object per version of a large file
 * {key} is the path with encodeURIComponent, so it is one document id.
 */
import { randomBytes } from 'node:crypto'

// The rules of docs/store-protocol.md, copied from grndwrk's src/shared-store/protocol.ts
// (a team's copy of this file cannot import grndwrk). test/store-firebase.test.ts keeps them equal.

export const PROTOCOL = 1
const SYNCED_FILES = ['project.md']
const SYNCED_FOLDERS = ['nodes', 'threads', 'stories', 'screens', 'personas', 'segments', 'waiting', 'files', 'readiness', 'outputs', 'views']
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_TEXT = 1_000_000
export const MAX_PICTURE = 10_000_000
export const MAX_INBOX = 14_000_000
/** @type {Record<string, string>} */
const TYPES = { md: 'text/markdown', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
export const INBOX = /^inbox\/([A-Za-z0-9_-]{8,64})\/[A-Za-z0-9_-]{8,64}\.json$/
export const STATUS = /^status\/[A-Za-z0-9_-]{8,64}\.json$/
export const COMMENTER = /^[A-Za-z0-9_-]{8,64}$/
/**
 * What one commenter may leave in the inbox through a comment token. Such a
 * token may sit in a staging page, where any script on it can read it, so it
 * must never be able to fill the store. Beyond these, the function answers 429.
 * @typedef {{ filesPerHour: number, bytesPerHour: number, waiting: number, total: number }} InboxLimits
 *   filesPerHour and bytesPerHour: what one commenter may leave in an hour; waiting: its files
 *   not filed yet, at most; total: the whole map's inbox files not filed yet, at most.
 */
/** @type {InboxLimits} */
export const INBOX_LIMITS = { filesPerHour: 60, bytesPerHour: 100_000_000, waiting: 500, total: 5000 }
const HOUR = 3_600_000

/** A Firestore document holds at most 1 MiB: anything larger goes to Storage. */
export const INLINE = 900_000
/** How many changes one answer holds at most. */
const PAGE = 500

/**
 * Why a path may not be in a store, or '' when it may.
 * @param {unknown} path
 */
export function pathProblem(path) {
  if (typeof path !== 'string' || !path) return 'A path is required'
  if (INBOX.test(path) || STATUS.test(path)) return ''
  if (path.length > 300) return 'A path is at most 300 characters'
  const parts = path.split('/')
  if (parts.length > 8) return 'A path has at most eight parts'
  if (!parts.every((p) => PART.test(p) && p !== '.' && p !== '..')) return 'Each part of a path starts with a letter or digit and holds only letters, digits, ".", "_" and "-"'
  const synced = parts.length === 1 ? SYNCED_FILES.includes(parts[0]) : SYNCED_FOLDERS.includes(parts[0])
  if (!synced) return `${path} is not something a store keeps`
  if (!typeOf(path)) return 'Only .md, .json, .png and .jpg files are kept'
  return ''
}

/** @param {string} path */
export function typeOf(path) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? ''
  return TYPES[ext] ?? ''
}

/**
 * Why these bytes may not be kept at this path, or ''. Pictures must really be PNG or JPEG.
 * @param {string} path
 * @param {Uint8Array} bytes
 */
export function bytesProblem(path, bytes) {
  const type = typeOf(path)
  if (type === 'image/png' || type === 'image/jpeg') {
    if (bytes.length > MAX_PICTURE) return `A picture is at most ${MAX_PICTURE / 1_000_000} MB`
    const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (type === 'image/png' ? !png : !jpeg) return `${path} is not a ${type === 'image/png' ? 'PNG' : 'JPEG'}`
    return ''
  }
  if (INBOX.test(path)) return bytes.length > MAX_INBOX ? `A comment is at most ${MAX_INBOX / 1_000_000} MB` : ''
  if (bytes.length > MAX_TEXT) return `A text file is at most ${MAX_TEXT / 1_000_000} MB`
  return ''
}

/**
 * Why a commenter may not leave this many bytes now, in plain words, or ''.
 * @param {InboxLimits} l
 * @param {{ at: number, size: number }[]} recent what it left in the last hour
 * @param {number} size
 * @param {number} waiting its inbox files not filed yet
 * @param {number} total the map's inbox files not filed yet
 */
export function overLimit(l, recent, size, waiting, total) {
  if (recent.length + 1 > l.filesPerHour) return `At most ${l.filesPerHour} comments an hour: try again later`
  if (recent.reduce((sum, r) => sum + r.size, 0) + size > l.bytesPerHour) return `At most ${Math.round(l.bytesPerHour / 1_000_000)} MB of comments an hour: try again later`
  if (waiting >= l.waiting) return `${l.waiting} of your comments are still waiting to be read: try again later`
  if (total >= l.total) return 'Too many comments are waiting to be read: try again later'
  return ''
}

/** @param {Uint8Array} bytes */
const isObject = (bytes) => {
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/** The store no longer knows the cursor. grndwrk's own CursorGone is matched by name. */
export class CursorGone extends Error {
  name = 'CursorGone'
}

/**
 * What the store needs from Firestore and Storage, so the logic runs on a fake in tests.
 * @typedef {Record<string, any>} Doc
 * @typedef {{ get(path: string): Promise<Doc | null>, set(path: string, data: Doc): void, delete(path: string): void }} Tx
 *   A transaction: every get before any set or delete, as Firestore requires.
 * @typedef {{
 *   get(path: string): Promise<Doc | null>,
 *   transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>,
 *   after(collection: string, at: number, limit: number): Promise<Doc[]>,
 *   save(name: string, bytes: Uint8Array, type: string): Promise<void>,
 *   load(name: string): Promise<Uint8Array | null>,
 *   drop(name: string): Promise<void>,
 *   maps?(): Promise<string[]>,
 * }} Backend
 *   `after`: the documents of a collection whose `at` is above the given one, lowest first.
 *   `maps`: the ids of the maps under projects/, for GET /v1/projects (the Cloud Function only).
 */

/** @param {string} path */
const keyOf = (path) => encodeURIComponent(path)

/**
 * The store's calls (the StoreClient of docs/store-protocol.md) over one map in Firestore.
 * @param {Backend} backend
 * @param {string} map The id of the map's document under projects/.
 * @param {{ name?: string }} [options]
 */
export function storeOver(backend, map, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(map)) throw new Error(`Not a map id: ${map}`)
  const root = `projects/${map}`
  const fileDoc = (/** @type {string} */ path) => `${root}/files/${keyOf(path)}`
  const changeDoc = (/** @type {string} */ path) => `${root}/changes/${keyOf(path)}`
  const commenterDoc = (/** @type {string} */ commenter) => `${root}/commenters/${commenter}`

  return {
    async hello() {
      const p = await backend.get(root)
      return { protocol: PROTOCOL, project: typeof p?.name === 'string' ? p.name : (options.name ?? map), writable: true, role: /** @type {const} */ ('write') }
    },

    /** @param {{ since?: string, wait?: number }} [o] `wait` is ignored: answering at once is always allowed. */
    async changes({ since } = {}) {
      let from = 0
      if (since !== undefined && since !== '') {
        const m = /^c_(\d{1,15})$/.exec(since)
        const p = await backend.get(root)
        // A cursor from the future, or from before tombstones were pruned (floor), is not one this store can follow.
        if (!m || Number(m[1]) > (p?.counter ?? 0) || Number(m[1]) < (p?.floor ?? 0)) throw new CursorGone(since)
        from = Number(m[1])
      }
      const rows = await backend.after(`${root}/changes`, from, PAGE + 1)
      const page = rows.slice(0, PAGE)
      const all = since === undefined || since === ''
      const changes = page.filter((r) => !(all && r.deleted)).map((r) => (r.deleted ? { path: String(r.path), deleted: true } : { path: String(r.path), version: String(r.version) }))
      return { cursor: `c_${page.length ? page[page.length - 1].at : from}`, changes, more: rows.length > PAGE }
    },

    /** @param {string} path */
    async read(path) {
      const problem = pathProblem(path)
      if (problem) throw new Error(problem)
      // A large file replaced between reading its document and its blob: read again.
      for (let i = 0; i < 3; i++) {
        const f = await backend.get(fileDoc(path))
        if (!f) return null
        const bytes = f.blob ? await backend.load(f.blob) : new Uint8Array(f.data)
        if (bytes) return { bytes, version: String(f.version), type: typeOf(path) }
      }
      throw new Error(`${path} keeps changing; try again`)
    },

    /**
     * @param {string} path
     * @param {Uint8Array} bytes
     * @param {{ type: string, create?: boolean, ifVersion?: string, limits?: InboxLimits, now?: number }} o
     *   `limits`: a comment token's write, held to them inside the transaction; refused as `{ ok: false, limited: '<why>' }`.
     */
    async write(path, bytes, { create, ifVersion, limits, now = Date.now() }) {
      const problem = pathProblem(path) || bytesProblem(path, bytes) || (INBOX.test(path) && !isObject(bytes) ? 'An inbox file is a JSON object' : '')
      if (problem) throw new Error(problem)
      const type = typeOf(path)
      // A large file goes to Storage under a name of its own before the transaction, so a refused write never touches what is there.
      const blob = bytes.length > INLINE ? `${root}/blobs/${randomBytes(12).toString('hex')}` : null
      if (blob) await backend.save(blob, bytes, type)
      const commenter = INBOX.exec(path)?.[1]
      /** @type {{ ok: boolean, version: string | null, old: string | null, limited?: string }} */
      const done = await backend.transaction(async (tx) => {
        const p = await tx.get(root)
        const there = await tx.get(fileDoc(path))
        const c = commenter ? await tx.get(commenterDoc(commenter)) : null
        if (create ? there : !there || there.version !== ifVersion) return { ok: false, version: there ? String(there.version) : null, old: null }
        // Inside the transaction, so two comments at once cannot both slip under a limit.
        /** @type {{ at: number, size: number }[]} */
        const recent = (Array.isArray(c?.recent) ? c.recent : []).filter((/** @type {any} */ r) => typeof r?.at === 'number' && typeof r?.size === 'number' && r.at > now - HOUR)
        if (limits && commenter) {
          const limited = overLimit(limits, recent, bytes.length, c?.waiting ?? 0, p?.inbox ?? 0)
          if (limited) return { ok: false, version: null, old: null, limited }
        }
        const at = (p?.counter ?? 0) + 1
        const version = `v${at}`
        const fresh = commenter && !there
        tx.set(root, { ...p, counter: at, ...(fresh ? { inbox: (p?.inbox ?? 0) + 1 } : {}) })
        tx.set(fileDoc(path), { path, version, type, size: bytes.length, at, ...(blob ? { blob } : { data: new Uint8Array(bytes) }) })
        tx.set(changeDoc(path), { path, version, at, deleted: false })
        if (commenter) tx.set(commenterDoc(commenter), { waiting: (c?.waiting ?? 0) + (fresh ? 1 : 0), recent: limits ? [...recent, { at: now, size: bytes.length }] : recent })
        return { ok: true, version, old: there?.blob ? String(there.blob) : null }
      })
      if (!done.ok && blob) await backend.drop(blob).catch(() => {})
      if (done.ok && done.old) await backend.drop(done.old).catch(() => {})
      if (done.limited) return { ok: /** @type {const} */ (false), version: null, limited: done.limited }
      return done.ok ? { ok: /** @type {const} */ (true), version: /** @type {string} */ (done.version) } : { ok: /** @type {const} */ (false), version: done.version }
    },

    /**
     * @param {string} path
     * @param {string} ifVersion
     */
    async remove(path, ifVersion) {
      const problem = pathProblem(path)
      if (problem) throw new Error(problem)
      const commenter = INBOX.exec(path)?.[1]
      const done = await backend.transaction(async (tx) => {
        const p = await tx.get(root)
        const there = await tx.get(fileDoc(path))
        const c = commenter ? await tx.get(commenterDoc(commenter)) : null
        if (!there) return { ok: false, gone: true, version: null, old: null }
        if (there.version !== ifVersion) return { ok: false, gone: false, version: String(there.version), old: null }
        const at = (p?.counter ?? 0) + 1
        // A filed comment no longer counts as waiting.
        tx.set(root, { ...p, counter: at, ...(commenter ? { inbox: Math.max(0, (p?.inbox ?? 0) - 1) } : {}) })
        if (commenter) tx.set(commenterDoc(commenter), { ...c, waiting: Math.max(0, (c?.waiting ?? 0) - 1) })
        tx.delete(fileDoc(path))
        tx.set(changeDoc(path), { path, at, deleted: true })
        return { ok: true, gone: false, version: '', old: there.blob ? String(there.blob) : null }
      })
      if (done.ok && done.old) await backend.drop(done.old).catch(() => {})
      if (done.ok) return { ok: /** @type {const} */ (true), version: '' }
      if (done.gone) return { ok: /** @type {const} */ (false), version: null, gone: /** @type {const} */ (true) }
      return { ok: /** @type {const} */ (false), version: done.version }
    },
  }
}

/**
 * The backend over firebase-admin: a Firestore and a function that gives the
 * Storage bucket (asked for only when a file is too large for a document).
 * Not run by the tests: it needs a Firebase project or the emulator.
 * @param {any} db firebase-admin's Firestore
 * @param {() => any} bucket firebase-admin's Storage bucket
 * @returns {Backend}
 */
export function firebaseBackend(db, bucket) {
  /** @param {any} snap */
  const plain = (snap) => (snap.exists ? snap.data() : null)
  // Firestore keeps bytes as a Buffer.
  /** @param {Doc} d */
  const out = (d) => (d.data instanceof Uint8Array ? { ...d, data: Buffer.from(d.data) } : d)
  return {
    get: async (path) => plain(await db.doc(path).get()),
    transaction: (fn) =>
      db.runTransaction(async (/** @type {any} */ t) =>
        fn({
          get: async (path) => plain(await t.get(db.doc(path))),
          set: (path, data) => void t.set(db.doc(path), out(data)),
          delete: (path) => void t.delete(db.doc(path)),
        }),
      ),
    after: async (collection, at, limit) => (await db.collection(collection).where('at', '>', at).orderBy('at').limit(limit).get()).docs.map((/** @type {any} */ d) => d.data()),
    save: async (name, bytes, type) => {
      await bucket().file(name).save(Buffer.from(bytes), { contentType: type, resumable: false })
    },
    load: async (name) => {
      try {
        const [b] = await bucket().file(name).download()
        return new Uint8Array(b)
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 404) return null
        throw err
      }
    },
    drop: async (name) => {
      await bucket().file(name).delete({ ignoreNotFound: true })
    },
    // Every map, also one whose document holds nothing but its members.
    maps: async () => (await db.collection('projects').listDocuments()).map((/** @type {any} */ d) => d.id),
  }
}

/** @param {string} name */
export const mapId = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'map'

/**
 * What grndwrk loads. Credentials come from the environment, never from
 * .grndwrk/: GOOGLE_APPLICATION_CREDENTIALS (or `gcloud auth
 * application-default login`), GRNDWRK_FIREBASE_BUCKET for Storage, and
 * GRNDWRK_FIREBASE_MAP when the map's id is not the project's name in lower case.
 * @param {{ project: string, root: string }} options
 */
export default async function store({ project }) {
  // Named in full, never in a variable, so grndwrk can see this file imports packages only (an allowed adapter is one file).
  // firebase-admin is installed only where the store runs, not in grndwrk's repository, whose checks read this file too.
  // @ts-expect-error: not installed in grndwrk's own repository
  const { applicationDefault, getApps, initializeApp } = await import('firebase-admin/app')
  // @ts-expect-error: not installed in grndwrk's own repository
  const { getFirestore } = await import('firebase-admin/firestore')
  // @ts-expect-error: not installed in grndwrk's own repository
  const { getStorage } = await import('firebase-admin/storage')
  // An app of its own name, so a project that uses firebase-admin elsewhere keeps its default app.
  const app =
    getApps().find((/** @type {any} */ a) => a.name === 'grndwrk') ??
    initializeApp({ credential: applicationDefault(), projectId: process.env.GRNDWRK_FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT, storageBucket: process.env.GRNDWRK_FIREBASE_BUCKET }, 'grndwrk')
  return storeOver(
    firebaseBackend(getFirestore(app), () => getStorage(app).bucket()),
    process.env.GRNDWRK_FIREBASE_MAP || mapId(project),
    { name: project },
  )
}
