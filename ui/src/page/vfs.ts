/**
 * The map's files in memory, for the page on a store. The page runs the same
 * store code grndwrk runs on the Mac (src/store/*: parsing, threads as files,
 * writing only what changed); the page's build points their `./fs.js` and
 * `node:fs/promises` here, so that code reads and writes these files instead
 * of a disk. What a change wrote is then sent to the store with the protocol's
 * conditions (api-store.ts), file by file, so nothing is overwritten unseen.
 *
 * Paths are absolute, under ROOT for the map (`/map/nodes/n_k2m4ab.md`).
 * Anything else (the waiting names kept "on this Mac", under /local) lives
 * only in this tab.
 */
export const ROOT = '/map'

interface File {
  /** null: in the store, not read yet (pictures are read only when shown). */
  bytes: Uint8Array | null
  /** The store's version of what `bytes` holds; '' for a file only this tab has. */
  version: string
  mtime: Date
}

const files = new Map<string, File>()
const dirs = new Set<string>()
/** What each path held before the change being made now, to send only what changed and to undo it. */
let touched: Map<string, File | null> | null = null
/** Reads a picture's bytes from the store when the store code asks for them. */
let loader: ((path: string) => Promise<{ bytes: Uint8Array; version: string } | null>) | null = null

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Kept for the store code's `catch (err instanceof LinkRefused)`: the page has no links to refuse. */
export class LinkRefused extends Error {}

function norm(path: string | URL): string {
  const parts: string[] = []
  for (const p of String(path).split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' })
}

function touch(path: string) {
  if (touched && !touched.has(path)) {
    const f = files.get(path)
    touched.set(path, f ? { ...f } : null)
  }
}

const asText = (opts: unknown) => opts === 'utf8' || opts === 'utf-8' || (typeof opts === 'object' && opts !== null && /utf-?8/i.test(String((opts as { encoding?: string }).encoding ?? '')))

export async function readFile(path: string | URL, opts?: unknown): Promise<never> {
  const p = norm(path)
  const f = files.get(p)
  if (!f) throw missing(p)
  if (!f.bytes) {
    const got = await loader?.(p.slice(ROOT.length + 1))
    if (!got) throw missing(p)
    f.bytes = got.bytes
    f.version = got.version
  }
  return (asText(opts) ? dec.decode(f.bytes) : f.bytes) as never
}

export async function writeFile(path: string | URL, data: string | Uint8Array, _opts?: unknown): Promise<void> {
  const p = norm(path)
  touch(p)
  const was = files.get(p)
  files.set(p, { bytes: typeof data === 'string' ? enc.encode(data) : new Uint8Array(data), version: was?.version ?? '', mtime: new Date() })
}

export async function appendFile(path: string | URL, data: string | Uint8Array, _opts?: unknown): Promise<void> {
  const p = norm(path)
  const before = files.has(p) ? ((await readFile(p)) as unknown as Uint8Array) : new Uint8Array()
  const more = typeof data === 'string' ? enc.encode(data) : data
  const both = new Uint8Array(before.length + more.length)
  both.set(before)
  both.set(more, before.length)
  await writeFile(p, both)
}

export async function readdir(path: string | URL, _opts?: unknown): Promise<string[]> {
  const p = norm(path)
  const prefix = p === '/' ? '/' : `${p}/`
  const names = new Set<string>()
  for (const k of [...files.keys(), ...dirs]) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
  names.delete('')
  if (!names.size && !dirs.has(p)) throw missing(p)
  return [...names]
}

export async function mkdir(path: string | URL, _opts?: unknown): Promise<undefined> {
  dirs.add(norm(path))
  return undefined
}

export async function stat(path: string | URL) {
  const p = norm(path)
  const f = files.get(p)
  if (!f && !dirs.has(p)) {
    // A folder exists when something is in it.
    if (![...files.keys()].some((k) => k.startsWith(`${p}/`))) throw missing(p)
  }
  return { mtime: f?.mtime ?? new Date(0), isFile: () => !!f, isDirectory: () => !f, size: f?.bytes?.length ?? 0 }
}
export const lstat = stat

export async function unlink(path: string | URL): Promise<void> {
  const p = norm(path)
  if (!files.has(p)) throw missing(p)
  touch(p)
  files.delete(p)
}

export async function rm(path: string | URL, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
  const p = norm(path)
  const under = [...files.keys()].filter((k) => k === p || (opts?.recursive && k.startsWith(`${p}/`)))
  if (!under.length && !opts?.force && !dirs.has(p)) throw missing(p)
  for (const k of under) {
    touch(k)
    files.delete(k)
  }
  for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
}

export async function rename(from: string | URL, to: string | URL): Promise<void> {
  const a = norm(from)
  const b = norm(to)
  const f = files.get(a)
  if (!f) throw missing(a)
  touch(a)
  touch(b)
  files.delete(a)
  // The target keeps its own version: renaming over a file is replacing that file.
  files.set(b, { ...f, version: files.get(b)?.version ?? (touched?.get(b)?.version ?? '') })
}

export async function chmod(): Promise<void> {}

/** The store code's guarded calls, under the names src/store/fs.ts gives them. */
export default { readFile, writeFile, appendFile, readdir, mkdir, stat, lstat, unlink, rm, rename, chmod }

// The side api-store.ts uses: what the store holds, and what a change wrote.

export function setLoader(f: typeof loader) {
  loader = f
}

const full = (path: string) => `${ROOT}/${path}`

/** A file as the store has it now (bytes null: not read yet). */
export function putStored(path: string, bytes: Uint8Array | null, version: string, mtime = new Date()) {
  files.set(full(path), { bytes, version, mtime })
}

export function dropStored(path: string) {
  files.delete(full(path))
}

export function storedVersion(path: string): string | null {
  return files.get(full(path))?.version ?? null
}

/** Every map path this tab holds, relative to the map. */
export function storedPaths(): string[] {
  return [...files.keys()].filter((k) => k.startsWith(`${ROOT}/`)).map((k) => k.slice(ROOT.length + 1))
}

export function clearAll() {
  files.clear()
  dirs.clear()
}

/** One step of sending a change to the store. */
export type Op =
  | { kind: 'create'; path: string; bytes: Uint8Array }
  | { kind: 'replace'; path: string; bytes: Uint8Array; version: string }
  | { kind: 'remove'; path: string; version: string }

/** Start recording a change. */
export function begin() {
  touched = new Map()
}

/** Stop recording: what the change did to the map's files, in the order it touched them. */
export function end(): Op[] {
  const was = touched ?? new Map()
  touched = null
  const ops: Op[] = []
  for (const [p, before] of was) {
    if (!p.startsWith(`${ROOT}/`)) continue
    const path = p.slice(ROOT.length + 1)
    const now = files.get(p)
    if (!now && before?.version) ops.push({ kind: 'remove', path, version: before.version })
    else if (now?.bytes && !before) ops.push({ kind: 'create', path, bytes: now.bytes })
    else if (now?.bytes && before && !same(now.bytes, before.bytes)) {
      ops.push(before.version ? { kind: 'replace', path, bytes: now.bytes, version: before.version } : { kind: 'create', path, bytes: now.bytes })
    }
  }
  // Undo needs what was there; kept until the change is sent or taken back.
  lastTouched = was
  return ops
}

let lastTouched: Map<string, File | null> = new Map()

/** Put every file the last change touched back as it was before it. */
export function undoLast() {
  for (const [p, before] of lastTouched) {
    if (before) files.set(p, before)
    else files.delete(p)
  }
  lastTouched = new Map()
}

/** The store took a write: the file now has this version. */
export function confirmed(path: string, version: string) {
  const f = files.get(full(path))
  if (f) f.version = version
  // The undo of this file would bring back a version the store no longer has.
  lastTouched.delete(full(path))
}

function same(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Another project's map, read for a moment to count what waits there (All projects).
// Under a root of its own, never ROOT, so nothing of it is ever sent to this project's store.

/** Put a file of another project's map under `root`. */
export function putElsewhere(root: string, path: string, bytes: Uint8Array) {
  if (root === ROOT || !root.startsWith('/peek/')) throw new Error('Another project goes under /peek/')
  files.set(`${root}/${path}`, { bytes, version: '', mtime: new Date() })
}

/** Forget everything under `root` again. */
export function dropElsewhere(root: string) {
  if (root === ROOT) return
  for (const k of [...files.keys()]) if (k.startsWith(`${root}/`)) files.delete(k)
  for (const d of [...dirs]) if (d === root || d.startsWith(`${root}/`)) dirs.delete(d)
}
