/**
 * The grndwrk store protocol (docs/store-protocol.md): which files a store
 * keeps, their types and sizes, and the calls every store answers, over HTTP
 * or as an adapter. Everything that reaches a store, in either direction,
 * passes through these rules.
 */

export const PROTOCOL = 1

/** The top of `.grndwrk/` that is synced: a file, or a folder and everything under it. */
export const SYNCED_FILES = ['project.md']
export const SYNCED_FOLDERS = ['nodes', 'threads', 'stories', 'screens', 'personas', 'segments', 'waiting', 'files', 'readiness', 'outputs']

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_PATH = 300
export const MAX_TEXT = 1_000_000
export const MAX_PICTURE = 10_000_000
/** A comment in the inbox carries its picture, as /api/feedback does. */
export const MAX_INBOX = 14_000_000
export const MAX_VERSION = 100
export const MAX_CURSOR = 200

export const TYPES: Record<string, string> = { md: 'text/markdown', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

/**
 * Comments straight to the store: a commenter (a phone, a staging page)
 * drops one comment as `inbox/<id>.json`, and reads what became of its own
 * comments in `status/<commenter>.json`. grndwrk turns inbox files into
 * cards and writes the status; neither folder is synced into `.grndwrk/`.
 */
export const INBOX = /^inbox\/[A-Za-z0-9_-]{8,64}\.json$/
export const STATUS = /^status\/[A-Za-z0-9_-]{8,64}\.json$/

/** Whether a path is mirrored into `.grndwrk/` (the map), not one of the comment folders. */
export const isMapPath = (path: string) => !pathProblem(path) && !INBOX.test(path) && !STATUS.test(path)

/** Why a path may not be in a store, or '' when it may. */
export function pathProblem(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'A path is required'
  if (INBOX.test(path) || STATUS.test(path)) return ''
  if (path.length > MAX_PATH) return `A path is at most ${MAX_PATH} characters`
  const parts = path.split('/')
  if (parts.length > 8) return 'A path has at most eight parts'
  if (!parts.every((p) => PART.test(p) && p !== '.' && p !== '..')) return 'Each part of a path starts with a letter or digit and holds only letters, digits, ".", "_" and "-"'
  const synced = parts.length === 1 ? SYNCED_FILES.includes(parts[0]) : SYNCED_FOLDERS.includes(parts[0])
  if (!synced) return `${path} is not something a store keeps`
  if (!typeOf(path)) return 'Only .md, .json, .png and .jpg files are kept'
  return ''
}

/** The type a path's extension stands for, or '' for any other. */
export function typeOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? ''
  return TYPES[ext] ?? ''
}

export const isPicture = (type: string) => type === 'image/png' || type === 'image/jpeg'

/** Why these bytes may not be kept at this path, or ''. Pictures must really be PNG or JPEG. */
export function bytesProblem(path: string, bytes: Uint8Array): string {
  const type = typeOf(path)
  if (isPicture(type)) {
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

export interface Change {
  path: string
  version?: string
  deleted?: boolean
}

export interface Changes {
  cursor: string
  changes: Change[]
  more?: boolean
}

/** What a token may do: read the map, change it, or only leave comments (and read their status). */
export type Role = 'read' | 'write' | 'comment'

export interface Hello {
  protocol: number
  project: string
  writable: boolean
  role?: Role
}

export interface Read {
  bytes: Uint8Array
  version: string
  type: string
}

/** A write or a delete: done, or refused because the version there is another (null: none). */
export type Written = { ok: true; version: string } | { ok: false; version: string | null }

/**
 * A store, however it is reached: over HTTP (`HttpStore`), through an
 * allowed adapter, or in memory (`MemoryStore`). The same calls, with the
 * same meaning, as docs/store-protocol.md.
 */
export interface StoreClient {
  hello(): Promise<Hello>
  /** A cursor the store no longer knows throws `CursorGone`. */
  changes(options: { since?: string; wait?: number }): Promise<Changes>
  read(path: string): Promise<Read | null>
  write(path: string, bytes: Uint8Array, options: { type: string; create?: boolean; ifVersion?: string }): Promise<Written>
  remove(path: string, ifVersion: string): Promise<Written | { ok: false; version: null; gone: true }>
}

/** The store no longer knows the cursor: read everything again. */
export class CursorGone extends Error {}

/** A store answered something the protocol does not allow. */
export class StoreBroke extends Error {}

/** Check a store's answer to `changes` before anything trusts it. */
export function checkChanges(value: unknown): Changes {
  const v = value as Changes
  if (!v || typeof v !== 'object' || typeof v.cursor !== 'string' || v.cursor.length > MAX_CURSOR || !Array.isArray(v.changes)) throw new StoreBroke('changes: expected { cursor, changes: [...] }')
  for (const c of v.changes) {
    if (!c || typeof c !== 'object' || pathProblem(c.path)) throw new StoreBroke(`changes: a path that is not allowed: ${String(c?.path).slice(0, 80)}`)
    if (!c.deleted && (typeof c.version !== 'string' || !c.version || c.version.length > MAX_VERSION)) throw new StoreBroke(`changes: ${c.path} has no version`)
  }
  return { cursor: v.cursor, changes: v.changes.map((c) => (c.deleted ? { path: c.path, deleted: true } : { path: c.path, version: c.version })), more: v.more === true }
}

export function checkVersion(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > MAX_VERSION) throw new StoreBroke('a version is a string of at most 100 characters')
  return v
}
