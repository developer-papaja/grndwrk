/**
 * A grndwrk store (docs/store-protocol.md) for one project, over any
 * key-value storage: a Durable Object's in worker.ts, a Map in the tests.
 * No Cloudflare imports, so the tests run it on Node.
 *
 * Paths, under the project (`/<project>/`):
 *   GET    v1/hello, v1/changes?since=&wait=, v1/files/<path>
 *   PUT    v1/files/<path>   with If-None-Match: * or If-Match: "<version>"
 *   DELETE v1/files/<path>   with If-Match: "<version>"
 *   OPTIONS                  the preflight for a staging site in COMMENT_ORIGINS, on the comment calls only
 * Whoever deployed it (Bearer OWNER_AUTH):
 *   POST   admin/tokens {role, commenter?, name?, label?}  a new token, shown once
 *   GET    admin/tokens         the tokens, without their secrets
 *   DELETE admin/tokens/<id>    revoke one
 *
 * Storage keys:
 *   meta:<path>        {version, type, size, chunks}
 *   blob:<version>:<n> the bytes, in chunks under the storage's value limit
 *   log:<at>           the latest change of one path, at that point of the clock
 *   at:<path>          where that path's change sits in the log
 *   clock              the last number handed out; versions are v<clock>, cursors c_<clock>
 *   token:<sha256>     {id, role, commenter?, name?, label?, created}, only a hash of the token
 *   tokenid:<id>       the hash, to revoke by id
 *
 * The protocol's rules come from grndwrk itself (src/shared-store/protocol.ts),
 * copied here so this folder deploys on its own. Keep them the same.
 */

export interface Storage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
  list<T>(options: { prefix: string; start?: string; limit?: number }): Promise<Map<string, T>>
}

export type Role = 'read' | 'write' | 'comment'
export interface Who { role: Role; commenter?: string; name?: string }
/** Another way to know who is asking (Cloudflare Access, access.ts), tried when there is no token. */
export type Identify = (req: Request, project: string) => Promise<Who | null>

interface Meta { version: string; type: string; size: number; chunks: number }
interface Change { path: string; version?: string; deleted?: boolean }
interface Token { id: string; role: Role; commenter?: string; name?: string; label?: string; created: string }

// The protocol's rules, as in src/shared-store/protocol.ts.
const SYNCED_FILES = ['project.md']
const SYNCED_FOLDERS = ['nodes', 'threads', 'stories', 'screens', 'personas', 'segments', 'waiting', 'files', 'readiness', 'outputs', 'views']
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const INBOX = /^inbox\/([A-Za-z0-9_-]{8,64})\/[A-Za-z0-9_-]{8,64}\.json$/
const STATUS = /^status\/[A-Za-z0-9_-]{8,64}\.json$/
const COMMENTER = /^[A-Za-z0-9_-]{8,64}$/
const TYPES: Record<string, string> = { md: 'text/markdown', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
export const LIMITS = { text: 1_000_000, picture: 10_000_000, inbox: 14_000_000, path: 300, wait: 25, page: 500 }
/** Durable Object storage keeps at most 128 KiB per value (the SQLite backend more), so files go in chunks below that. */
export const CHUNK = 120 * 1024

const typeOf = (path: string) => TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? ''] ?? ''
const isPicture = (type: string) => type === 'image/png' || type === 'image/jpeg'

export function pathProblem(path: string): string {
  if (!path) return 'A path is required'
  if (INBOX.test(path) || STATUS.test(path)) return ''
  if (path.length > LIMITS.path) return `A path is at most ${LIMITS.path} characters`
  const parts = path.split('/')
  if (parts.length > 8) return 'A path has at most eight parts'
  if (!parts.every((p) => PART.test(p) && p !== '.' && p !== '..')) return 'Each part of a path starts with a letter or digit and holds only letters, digits, ".", "_" and "-"'
  const synced = parts.length === 1 ? SYNCED_FILES.includes(parts[0]) : SYNCED_FOLDERS.includes(parts[0])
  if (!synced) return `${path} is not something this store keeps`
  if (!typeOf(path)) return 'Only .md, .json, .png and .jpg files are kept'
  return ''
}

/** Why these bytes may not be kept: [status, words], or null. Pictures must really be PNG or JPEG. */
function bytesProblem(path: string, bytes: Uint8Array): [number, string] | null {
  const type = typeOf(path)
  if (isPicture(type)) {
    if (bytes.length > LIMITS.picture) return [413, 'A picture is at most 10 MB']
    const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return (type === 'image/png' ? png : jpeg) ? null : [415, `Not a ${type === 'image/png' ? 'PNG' : 'JPEG'}`]
  }
  if (INBOX.test(path)) return bytes.length > LIMITS.inbox ? [413, 'A comment is at most 14 MB'] : null
  return bytes.length > LIMITS.text ? [413, 'A text file is at most 1 MB'] : null
}

const pad = (n: number) => String(n).padStart(15, '0')
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const random = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** Equal without saying where they differ: both sides are hashes of the same length. */
const same = (a: string, b: string) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0

/** The three calls a staging site's Comment button makes: hello, leaving a comment, reading its status. */
const commentCall = (route: string, method: string) =>
  (route === 'hello' && method === 'GET') || (route.startsWith('files/inbox/') && method === 'PUT') || (route.startsWith('files/status/') && method === 'GET')
const cors = (site: string) => ({
  'Access-Control-Allow-Origin': site,
  'Access-Control-Allow-Methods': 'GET, PUT',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  Vary: 'Origin',
})
/** COMMENT_ORIGINS: https origins, exactly as a browser sends them, separated by commas or spaces. */
export const parseOrigins = (value = '') => value.split(/[\s,]+/).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(o))

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
const error = (status: number, words: string) => json(status, { error: words })

export class Store {
  /** One write at a time: the check of a version and the write after it never interleave with another. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Long polls waiting for the next change; only this object's memory, which is fine since one object serves a project. */
  private waiters = new Set<() => void>()

  constructor(
    private storage: Storage,
    private options: { ownerAuth?: string; identify?: Identify; origins?: string[] } = {},
  ) {}

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }

  /** `project` is the URL's first segment, checked by the Worker. */
  async handle(req: Request, project: string): Promise<Response> {
    try {
      const url = new URL(req.url)
      const route = url.pathname.slice(project.length + 2)
      if (route === 'admin/tokens' || route.startsWith('admin/tokens/')) return await this.admin(req, route.slice(12), project)
      if (!route.startsWith('v1/')) return error(404, 'Not found')
      const origin = req.headers.get('origin') ?? ''
      const site = this.options.origins?.includes(origin) ? origin : ''
      if (req.method === 'OPTIONS') {
        // A preflight carries no token: allow the three calls a staging page makes, for a listed site, and nothing else.
        const ok = site && commentCall(route.slice(3), req.headers.get('access-control-request-method') ?? '')
        return ok ? new Response(null, { status: 204, headers: { ...cors(site), 'Access-Control-Max-Age': '600' } }) : error(403, 'Not allowed from this site')
      }
      const seen: { who?: Who } = {}
      const res = await this.protocol(req, url, route.slice(3), project, (w) => (seen.who = w))
      // CORS only for a comment token, or for no token at all (a 401 the page must be able to read), never for read or write tokens.
      const role = seen.who?.role
      if (site && commentCall(route.slice(3), req.method) && (!role || role === 'comment')) for (const [k, v] of Object.entries(cors(site))) res.headers.set(k, v)
      return res
    } catch (err) {
      return error(500, err instanceof Error ? err.message : String(err))
    }
  }

  private async who(req: Request, project: string): Promise<Who | null> {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (bearer) {
      const t = await this.storage.get<Token>(`token:${await sha256(bearer)}`)
      return t ? { role: t.role, commenter: t.commenter, name: t.name } : null
    }
    return this.options.identify ? this.options.identify(req, project) : null
  }

  private async protocol(req: Request, url: URL, route: string, project: string, seen: (who: Who) => void): Promise<Response> {
    const who = await this.who(req, project)
    if (!who) return error(401, 'A valid token is required')
    seen(who)
    // A comment token learns its commenter here: the folder its comments go in, and its status file.
    if (route === 'hello' && req.method === 'GET') return json(200, { protocol: 1, project, writable: who.role === 'write', role: who.role, ...(who.role === 'comment' ? { commenter: who.commenter } : {}) })
    let path = ''
    if (route.startsWith('files/')) {
      try {
        path = decodeURIComponent(route.slice(6))
      } catch {
        return error(400, 'A path that does not decode')
      }
    }
    // A commenter sees nothing of the map: its own status, and new files in its own inbox folder.
    if (who.role === 'comment') {
      const own = req.method === 'GET' ? path === `status/${who.commenter}.json` : req.method === 'PUT' && INBOX.exec(path)?.[1] === who.commenter && req.headers.get('if-none-match') === '*'
      if (!own) return error(403, 'This token may only leave comments')
    }
    if (route === 'changes' && req.method === 'GET') return this.changes(url)
    if (!route.startsWith('files/')) return error(404, 'Not found')
    const bad = pathProblem(path)
    if (bad) return error(400, bad)
    if (req.method === 'GET') return this.read(path)
    if (who.role === 'read') return error(403, 'This token may only read')
    const match = /^"(.*)"$/.exec(req.headers.get('if-match') ?? '')?.[1]
    const create = req.headers.get('if-none-match') === '*'
    if (req.method === 'PUT') {
      if (!create && match === undefined) return error(428, 'Send If-Match or If-None-Match: *')
      const max = INBOX.test(path) ? LIMITS.inbox : isPicture(typeOf(path)) ? LIMITS.picture : LIMITS.text
      if (Number(req.headers.get('content-length') ?? 0) > max) return error(413, 'Too large')
      let bytes = new Uint8Array(await req.arrayBuffer())
      const problem = bytesProblem(path, bytes)
      if (problem) return error(...problem)
      // A comment is a JSON object, whoever writes it; grndwrk believes the commenter in the path, and the name the store knows replaces whatever the device wrote.
      if (INBOX.test(path)) {
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return error(400, 'A comment is a JSON object')
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'A comment is a JSON object')
        if (who.role === 'comment' && who.name) {
          bytes = new TextEncoder().encode(JSON.stringify({ ...body, from: who.name }))
          if (bytes.length > LIMITS.inbox) return error(413, 'A comment is at most 14 MB')
        }
      }
      return this.write(path, bytes, create ? null : (match as string), create)
    }
    if (req.method === 'DELETE') {
      if (match === undefined) return error(428, 'Send If-Match')
      return this.remove(path, match)
    }
    return error(405, 'Not allowed')
  }

  private async changes(url: URL): Promise<Response> {
    const since = url.searchParams.get('since') || ''
    const wait = Math.min(LIMITS.wait, Math.max(0, Number(url.searchParams.get('wait')) || 0))
    const clock = (await this.storage.get<number>('clock')) ?? 0
    let from = 0
    if (since) {
      const n = /^c_(\d{1,15})$/.exec(since)?.[1]
      if (n === undefined || Number(n) > clock) return error(410, 'Unknown cursor: read everything again')
      from = Number(n)
    }
    let page = await this.page(from)
    if (since && !page.length && wait > 0) {
      await new Promise<void>((done) => {
        const wake = () => (clearTimeout(timer), this.waiters.delete(wake), done())
        const timer = setTimeout(wake, wait * 1000)
        this.waiters.add(wake)
      })
      page = await this.page(from)
    }
    const more = page.length > LIMITS.page
    const shown = page.slice(0, LIMITS.page)
    const last = shown.length ? shown[shown.length - 1][0] : from
    // Without a cursor, everything that exists: the log holds each path once, at its latest state, so leave out deletions.
    const changes = shown.map(([, c]) => c).filter((c) => since || !c.deleted)
    // The last entry read, never the clock: a write may have taken its number and not logged it yet.
    return json(200, { cursor: `c_${last}`, changes, more })
  }

  /** The log after a point, one more than a page to know whether there is more. */
  private async page(from: number): Promise<[number, Change][]> {
    const entries = await this.storage.list<Change>({ prefix: 'log:', start: `log:${pad(from + 1)}`, limit: LIMITS.page + 1 })
    return [...entries].map(([k, c]) => [Number(k.slice(4)), c])
  }

  private async read(path: string): Promise<Response> {
    // A write may replace the file while its chunks are read: then read the new version.
    for (let tries = 0; tries < 3; tries++) {
      const meta = await this.storage.get<Meta>(`meta:${path}`)
      if (!meta) return error(404, 'No such file')
      const chunks = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => this.storage.get<Uint8Array>(`blob:${meta.version}:${i}`)))
      if (chunks.some((c) => !c)) continue
      const bytes = new Uint8Array(meta.size)
      let at = 0
      for (const c of chunks as Uint8Array[]) {
        bytes.set(c, at)
        at += c.length
      }
      return this.file(meta, bytes)
    }
    return error(503, 'The file changed while it was read: try again')
  }

  private file(meta: Meta, bytes: Uint8Array<ArrayBuffer>): Response {
    // Never rendered here: people and agents wrote these files, and comments come from whoever used the product.
    return new Response(bytes, {
      headers: { 'Content-Type': meta.type, ETag: `"${meta.version}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" },
    })
  }

  private write(path: string, bytes: Uint8Array, ifVersion: string | null, create: boolean): Promise<Response> {
    return this.locked(async () => {
      const there = await this.storage.get<Meta>(`meta:${path}`)
      if (create ? there : !there || there.version !== ifVersion) return json(412, { version: there?.version ?? null })
      const at = await this.tick()
      const version = `v${at}`
      const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK))
      // The new bytes first, under their own version, then the pointer to them: a reader never sees half a file.
      for (let i = 0; i < chunks; i++) await this.storage.put(`blob:${version}:${i}`, bytes.slice(i * CHUNK, (i + 1) * CHUNK))
      await this.storage.put(`meta:${path}`, { version, type: typeOf(path), size: bytes.length, chunks } satisfies Meta)
      if (there) await this.dropBlob(there)
      await this.record(at, { path, version })
      return json(create ? 201 : 200, { version })
    })
  }

  private remove(path: string, ifVersion: string): Promise<Response> {
    return this.locked(async () => {
      const there = await this.storage.get<Meta>(`meta:${path}`)
      if (!there) return error(404, 'No such file')
      if (there.version !== ifVersion) return json(412, { version: there.version })
      await this.storage.delete(`meta:${path}`)
      await this.dropBlob(there)
      await this.record(await this.tick(), { path, deleted: true })
      return json(200, {})
    })
  }

  private async tick() {
    const at = ((await this.storage.get<number>('clock')) ?? 0) + 1
    await this.storage.put('clock', at)
    return at
  }

  private async dropBlob(meta: Meta) {
    for (let i = 0; i < meta.chunks; i++) await this.storage.delete(`blob:${meta.version}:${i}`)
  }

  /** Each path once in the log, at its latest change, so a cursor is a position and a page never repeats a path. */
  private async record(at: number, change: Change) {
    const before = await this.storage.get<number>(`at:${change.path}`)
    // The new entry before the old one goes: a reader in between may see the path twice, never not at all.
    await this.storage.put(`log:${pad(at)}`, change)
    await this.storage.put(`at:${change.path}`, at)
    if (before !== undefined) await this.storage.delete(`log:${pad(before)}`)
    for (const wake of [...this.waiters]) wake()
  }

  private async admin(req: Request, rest: string, project: string): Promise<Response> {
    const owner = this.options.ownerAuth
    const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? ''
    if (!owner) return error(403, 'OWNER_AUTH is not set on this Worker')
    if (!same(await sha256(bearer), await sha256(owner))) return error(401, 'Only whoever deployed the store hands out tokens')
    if (req.method === 'GET' && rest === '') {
      const all = await this.storage.list<Token>({ prefix: 'token:' })
      return json(200, { tokens: [...all.values()] })
    }
    if (req.method === 'POST' && rest === '') {
      let b: Record<string, unknown>
      try {
        b = (await req.json()) as Record<string, unknown>
      } catch {
        return error(400, 'Send JSON: {role, commenter?, name?, label?}')
      }
      const role = b?.role
      if (role !== 'read' && role !== 'write' && role !== 'comment') return error(400, 'role is read, write or comment')
      const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) : '')
      const t: Token = { id: `t_${random(9)}`, role, created: new Date().toISOString() }
      if (clean(b.label)) t.label = clean(b.label)
      if (role === 'comment') {
        const commenter = b.commenter === undefined ? `c_${random(12)}` : b.commenter
        if (typeof commenter !== 'string' || !COMMENTER.test(commenter)) return error(400, 'commenter is 8 to 64 letters, digits, _ or -')
        t.commenter = commenter
        if (clean(b.name)) t.name = clean(b.name)
      }
      // The project in front, so the store's root knows whose object to ask (GET /v1/projects); the secret is the rest.
      const token = `gws_${project}.${random(32)}`
      const hash = await sha256(token)
      await this.storage.put(`token:${hash}`, t)
      await this.storage.put(`tokenid:${t.id}`, hash)
      // The only time the token is shown: the store keeps its hash.
      return json(201, { ...t, token })
    }
    const id = /^\/(t_[A-Za-z0-9_-]{1,40})$/.exec(rest)?.[1]
    if (req.method === 'DELETE' && id) {
      const hash = await this.storage.get<string>(`tokenid:${id}`)
      if (!hash) return error(404, 'No such token')
      await this.storage.delete(`token:${hash}`)
      await this.storage.delete(`tokenid:${id}`)
      return json(200, {})
    }
    return error(404, 'Not found')
  }
}
