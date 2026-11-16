/**
 * `.grndwrk/` and the team's store, kept the same. The folder stays the
 * working copy every agent reads and writes; this mirrors each map file
 * (`isMapPath`) both ways, files comments the store's inbox holds, and
 * writes each commenter's status back.
 *
 * Per path it remembers, on this machine only (`.grndwrk/store-sync.json`,
 * git ignored), the store's version and a hash of the bytes at the last
 * sync. That is the common ancestor: only the store changed, the folder
 * takes it; only the folder changed, the store takes it (If-Match, so
 * nobody's words are overwritten); both changed, the store's version wins
 * in the folder and the local bytes are kept in grndwrk's per-user folder
 * (`store-conflicts/`), said in a line, never dropped. A delete is a change
 * like any other, and never removes a file someone changed meanwhile.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir as mkdirPlain, writeFile as writePlain } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { commentRequest, type CommentsCtx } from '../server/comments.js'
import { feedbackStatus } from '../server/feedback.js'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from '../store/fs.js'
import { keepOutOfGit } from '../store/gitignore.js'
import { BadInput } from '../store/nodes.js'
import { adapterState, openStore, readStoreConfig, storeStateDir } from './config.js'
import { bytesProblem, type Change, checkChanges, COMMENTER, CursorGone, INBOX, isMapPath, STATUS, StoreBroke, type StoreClient, SYNCED_FILES, SYNCED_FOLDERS, typeOf } from './protocol.js'

export const SYNC_STATE = 'store-sync.json'

/** The store answers, but this token cannot sync the map: trying again will not help. */
export class NotForSync extends StoreBroke {}

/** A round would delete more local files than a store plausibly removed at once: stopped, nothing more deleted. */
export class TooManyDeletes extends StoreBroke {}

interface Entry {
  version: string
  hash: string
}
interface State {
  /** Which store these versions came from: its address or adapter, and its project. */
  store?: string
  cursor?: string
  files: Record<string, Entry>
}

/** What one round did. */
export interface SyncCounts {
  /** Files the store had that the folder now has (new or changed). */
  pulled: number
  /** Files the folder had that the store now has. */
  pushed: number
  /** Deleted here because they were deleted in the store, and the other way. */
  deletedHere: number
  deletedThere: number
  /** Changed on both sides: the store's kept here, ours in `store-conflicts/`. */
  conflicts: number
  /** Comments from the inbox that became cards. */
  comments: number
  /** Test results and deletes from the inbox, each about a commenter's own comments. */
  results: number
}

const zero = (): SyncCounts => ({ pulled: 0, pushed: 0, deletedHere: 0, deletedThere: 0, conflicts: 0, comments: 0, results: 0 })
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SyncOptions {
  /** Where lines go; the console by default. */
  log?: (line: string) => void
  /** Asked before each pull: a reason to stop (the adapter changed since it was allowed), or null. */
  stillAllowed?: () => Promise<string | null>
  /** Milliseconds between scans of the folder, a safety net under the watcher. */
  scanEvery?: number
  /** Which store this is (its address, or `adapter:` and its path): versions from another store are never used. */
  identity?: string
  /** Let a round delete many files here, once the person said that is right (`grndwrk store sync --allow-deletes`). */
  allowManyDeletes?: boolean
}

export class StoreSync {
  private state: State = { files: {} }
  private loaded?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private counts = zero()
  private hashes = new Map<string, { mtime: number; size: number; hash: string }>()
  private pending = new Set<string>()
  private debounce?: NodeJS.Timeout
  private scanTimer?: NodeJS.Timeout
  private running = false
  private statusSent = new Map<string, string>()
  private inboxTries = new Map<string, number>()
  private said = new Map<string, string>()
  private deletedThisRound = 0
  /** Comments filed per commenter this round: a flood waits for later rounds instead of filling the map at once. */
  private filedThisRound = new Map<string, number>()
  /** The store sets `from` on every comment itself (hello `names: true`); otherwise a name is the device's own claim. */
  private names = false
  /** The staging site the store takes comments from (hello `site`): a comment's address is kept only on it. */
  private site = ''
  private log: (line: string) => void
  /** A token that may only read: the folder takes the store's changes, its own stay here. */
  readOnly = false
  /** The last failure, kept so it is said once, not every round. */
  error?: string

  constructor(
    private gwDir: string,
    private store: StoreClient,
    private ctx: CommentsCtx,
    private options: SyncOptions = {},
  ) {
    this.log = options.log ?? ((line) => console.log(line))
  }

  /** Where local bytes go when the store's version wins: outside the project, per project. */
  conflictsDir(): string {
    const root = dirname(this.gwDir)
    const name = basename(root).replace(/[^A-Za-z0-9._-]/g, '_') || 'project'
    return join(storeStateDir(), 'store-conflicts', `${name}-${hashOf(Buffer.from(root)).slice(0, 8)}`)
  }

  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      // Projects set up before the store: the sync state belongs to this machine, never to git.
      await keepOutOfGit(this.gwDir, SYNC_STATE)
      try {
        const v = JSON.parse(await readFile(join(this.gwDir, SYNC_STATE), 'utf8')) as State
        if (v && typeof v === 'object' && v.files && typeof v.files === 'object') {
          const files: Record<string, Entry> = {}
          for (const [p, e] of Object.entries(v.files)) if (isMapPath(p) && typeof e?.version === 'string' && typeof e?.hash === 'string') files[p] = { version: e.version, hash: e.hash }
          this.state = { ...(typeof v.store === 'string' ? { store: v.store } : {}), ...(typeof v.cursor === 'string' ? { cursor: v.cursor } : {}), files }
        }
      } catch {
        // None yet, or unreadable: the full pass compares everything.
      }
      const hello = await this.store.hello()
      if (hello.role === 'comment') throw new NotForSync('This token may only leave comments. Ask for one that may read the map, then run: grndwrk store login')
      // Versions from another store say nothing about this one: what it lacks was never deleted there.
      // Without this, pointing store.json at another store (a pull request can) would delete the folder.
      const identity = `${this.options.identity ?? ''}|${hello.project}`
      if (this.state.store !== undefined && this.state.store !== identity) {
        this.log('This map was synced with another store before. Starting afresh with this one: nothing here is deleted, and what only this folder has goes to this store.')
        this.state = { files: {} }
      }
      this.state.store = identity
      this.names = (hello as { names?: unknown }).names === true
      const site = (hello as { site?: unknown }).site
      try {
        const u = typeof site === 'string' ? new URL(site) : null
        this.site = u && u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' ? u.origin : ''
      } catch {
        this.site = ''
      }
      this.readOnly = !hello.writable
      if (this.readOnly) this.log('This token may only read the store: changes made here stay in the folder and are not sent.')
    })()
    this.loaded.catch(() => (this.loaded = undefined))
    return this.loaded
  }

  private async save() {
    const file = join(this.gwDir, SYNC_STATE)
    const tmp = join(this.gwDir, `.${SYNC_STATE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
    await writeFile(tmp, `${JSON.stringify(this.state, null, 1)}\n`)
    await rename(tmp, file)
  }

  /** One thing at a time: a pull, a push and a scan never interleave on the same file. */
  private run(fn: () => Promise<void>): Promise<SyncCounts> {
    const next = this.queue.then(async () => {
      this.counts = zero()
      this.deletedThisRound = 0
      this.filedThisRound.clear()
      await fn()
      return { ...this.counts }
    })
    this.queue = next.catch(() => {})
    return next
  }

  // The full pass and the pulls

  /** Everything compared: the store's files, the folder's, and what was there at the last sync. */
  async fullPass(): Promise<SyncCounts> {
    await this.ready()
    return this.run(async () => {
      const remote = new Map<string, string>()
      let page = checkChanges(await this.store.changes({}))
      for (let i = 0; ; i++) {
        for (const c of page.changes) c.deleted ? remote.delete(c.path) : remote.set(c.path, c.version as string)
        if (!page.more || i > 10_000) break
        page = checkChanges(await this.store.changes({ since: page.cursor }))
      }
      const paths = new Set([...[...remote.keys()].filter(isMapPath), ...(await this.listLocal()), ...Object.keys(this.state.files)])
      const failed: unknown[] = []
      for (const path of [...paths].sort()) await this.settle(path, remote.get(path) ?? null).catch((err) => failed.push(err))
      for (const [path, version] of remote) if (INBOX.test(path)) await this.takeComment(path, version).catch((err) => failed.push(err))
      // Advanced only when everything settled: a path that failed comes again.
      if (!failed.length) this.state.cursor = page.cursor
      await this.save()
      await this.afterBatch()
      if (failed.length) throw failed[0]
    })
  }

  /** What changed in the store since the last cursor, page after page. Without a cursor, a full pass. */
  async pull(wait = 0): Promise<SyncCounts> {
    await this.ready()
    if (!this.state.cursor) return this.fullPass()
    let first: { cursor: string; changes: Change[]; more?: boolean }
    try {
      // Outside the queue: a long poll must not hold up pushing what changes here meanwhile.
      first = checkChanges(await this.store.changes({ since: this.state.cursor, wait }))
    } catch (err) {
      if (!(err instanceof CursorGone)) throw err
      this.state.cursor = undefined
      return this.fullPass()
    }
    return this.run(async () => {
      let page = first
      for (let i = 0; i < 10_000; i++) {
        await this.apply(page.changes)
        this.state.cursor = page.cursor
        await this.save()
        if (!page.more) break
        page = checkChanges(await this.store.changes({ since: page.cursor }))
      }
      await this.afterBatch()
    })
  }

  private async apply(changes: Change[]) {
    const failed: unknown[] = []
    for (const c of changes) {
      try {
        if (INBOX.test(c.path)) {
          if (!c.deleted) await this.takeComment(c.path, c.version as string)
        } else if (STATUS.test(c.path)) {
          // Written by grndwrk itself, for the commenter: nothing to copy here.
        } else if (isMapPath(c.path)) {
          await this.settle(c.path, c.deleted ? null : (c.version as string))
        }
      } catch (err) {
        failed.push(err)
      }
    }
    // The cursor stays where it was: the whole page comes again, and what settled is a no-op then.
    if (failed.length) throw failed[0]
  }

  // Pushing

  /** A file in `.grndwrk/` changed (from the watcher): pushed shortly, together with others. */
  changed(rel: string) {
    if (!isMapPath(rel)) return
    this.pending.add(rel)
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      const paths = [...this.pending]
      this.pending.clear()
      this.pushLocal(paths).catch((err) => this.fail(err))
    }, 300)
  }

  /** What changed in the folder since the last sync, sent to the store: the given paths, or a scan of all. */
  async pushLocal(paths?: string[]): Promise<SyncCounts> {
    await this.ready()
    return this.run(async () => {
      try {
        await this.scan(paths)
      } finally {
        await this.save()
      }
      await this.sendStatus()
    })
  }

  private async scan(only?: string[]) {
    const list = only ?? [...new Set([...(await this.listLocal()), ...Object.keys(this.state.files)])]
    const failed: unknown[] = []
    for (const path of list) {
      if (!isMapPath(path)) continue
      // Only what differs from the last sync is read in full; the rest by size and time.
      const h = await this.cachedHash(path).catch(() => '?')
      if (h === (this.state.files[path]?.hash ?? null)) continue
      await this.settle(path, undefined).catch((err) => failed.push(err))
    }
    if (failed.length) throw failed[0]
  }

  // The three-way rules, for one path

  /**
   * `remote`: the store's version as the changes named it, null for none
   * (deleted, or not listed in a full pass), undefined when unknown (a local
   * change: the store is taken to be as at the last sync, and If-Match
   * finds out when it is not).
   */
  private async settle(path: string, remote: string | null | undefined, tries = 0): Promise<void> {
    if (!isMapPath(path)) return
    const before = this.state.files[path]
    const known = before?.version ?? null
    const local = await this.readLocal(path)
    const lh = local ? hashOf(local) : null
    const localChanged = lh !== (before?.hash ?? null)
    if ((remote === undefined ? known : remote) !== known) {
      const r = remote ? await this.store.read(path) : null
      // The changes may name a version that is already old; what is there now decides.
      if ((r?.version ?? null) !== known) return this.storeChanged(path, r, local, lh, localChanged, tries)
    }
    if (!localChanged || this.readOnly) return
    if (local) {
      const problem = bytesProblem(path, local)
      if (problem) return this.sayOnce(path, `${path} is not sent to the store: ${problem}.`)
      const w = await this.store.write(path, local, before ? { type: typeOf(path), ifVersion: before.version } : { type: typeOf(path), create: true })
      if (w.ok) {
        this.state.files[path] = { version: w.version, hash: lh as string }
        this.counts.pushed++
        return
      }
      // 412: someone changed it in the store meanwhile. Pull it, then the rules again.
      if (tries >= 3) throw new Error(`${path} keeps changing in the store; tried again on the next round`)
      return this.settle(path, w.version, tries + 1)
    }
    if (!before) return
    const r = await this.store.remove(path, before.version)
    if (r.ok || 'gone' in r) {
      delete this.state.files[path]
      if (r.ok) this.counts.deletedThere++
      return
    }
    // Changed in the store since: not removed, and the rules decide again (deleted here, changed there).
    if (tries >= 3) throw new Error(`${path} keeps changing in the store; tried again on the next round`)
    return this.settle(path, r.version, tries + 1)
  }

  private async storeChanged(path: string, r: { bytes: Uint8Array; version: string } | null, local: Uint8Array | null, lh: string | null, localChanged: boolean, tries: number) {
    if (r) {
      const problem = bytesProblem(path, r.bytes)
      if (problem) throw new StoreBroke(`The store sent ${path}, which is refused: ${problem}`)
    }
    const rh = r ? hashOf(r.bytes) : null
    // The same bytes on both sides (or gone on both): nothing to move, only remembered.
    if (rh === lh) {
      if (r) this.state.files[path] = { version: r.version, hash: rh as string }
      else delete this.state.files[path]
      return
    }
    if (!localChanged) {
      if (r) {
        await this.writeLocal(path, r.bytes, lh)
        this.state.files[path] = { version: r.version, hash: rh as string }
        this.counts.pulled++
      } else {
        if (await this.removeLocal(path, lh)) this.counts.deletedHere++
        delete this.state.files[path]
      }
      return
    }
    // Changed on both sides.
    if (r && local) {
      const kept = await this.keep(path, local)
      await this.writeLocal(path, r.bytes, lh)
      this.state.files[path] = { version: r.version, hash: rh as string }
      this.counts.conflicts++
      this.log(`${path} changed here and in the store at the same time. The store's version is in .grndwrk now; yours is kept in ${kept}`)
    } else if (r) {
      await this.writeLocal(path, r.bytes, null)
      this.state.files[path] = { version: r.version, hash: rh as string }
      this.counts.pulled++
      this.log(`${path} was deleted here, but changed in the store meanwhile: the changed version is back in .grndwrk.`)
    } else if (local) {
      // Deleted in the store, changed here: a delete never takes a change with it. Put back.
      delete this.state.files[path]
      if (this.readOnly) return
      const w = await this.store.write(path, local, { type: typeOf(path), create: true })
      if (!w.ok) {
        if (tries >= 3) throw new Error(`${path} keeps changing in the store; tried again on the next round`)
        return this.settle(path, w.version, tries + 1)
      }
      this.state.files[path] = { version: w.version, hash: lh as string }
      this.counts.pushed++
      this.log(`${path} was deleted in the store, but changed here meanwhile: kept, and put back in the store.`)
    }
  }

  // The folder

  private async readLocal(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.gwDir, path)))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
      throw err
    }
  }

  private async cachedHash(path: string): Promise<string | null> {
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(join(this.gwDir, path))
    } catch {
      this.hashes.delete(path)
      return null
    }
    const hit = this.hashes.get(path)
    if (hit && hit.mtime === s.mtimeMs && hit.size === s.size) return hit.hash
    const bytes = await this.readLocal(path)
    if (!bytes) return null
    const hash = hashOf(bytes)
    this.hashes.set(path, { mtime: s.mtimeMs, size: s.size, hash })
    return hash
  }

  /**
   * Written whole or not at all (a temp file, then a rename), through
   * src/store/fs.ts so no link is followed. If the file changed since it was
   * read (an agent writing at that moment), that change is kept first.
   */
  private async writeLocal(path: string, bytes: Uint8Array, expect: string | null) {
    if (!isMapPath(path)) throw new StoreBroke(`${path} is not part of the map`)
    const full = join(this.gwDir, path)
    const now = await this.readLocal(path)
    if (now && hashOf(now) !== expect) {
      const kept = await this.keep(path, now)
      this.counts.conflicts++
      this.log(`${path} changed here while the store's version came in. The store's version is in .grndwrk now; yours is kept in ${kept}`)
    }
    await mkdir(dirname(full), { recursive: true })
    const tmp = join(dirname(full), `.${basename(full)}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, full)
    this.hashes.delete(path)
  }

  /** Removed only when it is still what was synced: a change made meanwhile stays, and is sent as new. */
  private async removeLocal(path: string, expect: string | null): Promise<boolean> {
    const now = await this.readLocal(path)
    if (!now) return false
    if (hashOf(now) !== expect) return false
    // A store that suddenly lacks much of the map is more likely wrong (a mistake, another project, an attack) than emptied on purpose.
    const most = Math.max(10, Math.ceil(Object.keys(this.state.files).length * 0.2))
    if (!this.options.allowManyDeletes && ++this.deletedThisRound > most) {
      throw new TooManyDeletes(`The store no longer has many files this machine synced with it (more than ${most} in one go). Nothing more was deleted here. If they really were removed, run: grndwrk store sync --allow-deletes`)
    }
    await unlink(join(this.gwDir, path))
    this.hashes.delete(path)
    return true
  }

  private async keep(path: string, bytes: Uint8Array): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(this.conflictsDir(), stamp, ...path.split('/'))
    await mkdirPlain(dirname(file), { recursive: true })
    await writePlain(file, bytes, { mode: 0o600 })
    return file
  }

  /** Every map file in the folder: no dot files (temp files), no links, nothing the store would refuse by its path. */
  private async listLocal(): Promise<string[]> {
    const out: string[] = []
    for (const f of SYNCED_FILES) if (await this.readLocal(f).catch(() => null)) out.push(f)
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 8) return
      const entries = await readdir(join(this.gwDir, rel), { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue
        const p = `${rel}/${e.name}`
        if (e.isDirectory()) await walk(p, depth + 1)
        else if (e.isFile() && isMapPath(p)) out.push(p)
      }
    }
    for (const folder of SYNCED_FOLDERS) await walk(folder, 1)
    return out
  }

  // Comments straight to the store

  /**
   * A comment left in the store's inbox becomes a card exactly as one that
   * came over the relay: the same checks, its words quoted, marked when it
   * reads like orders to an agent. Who left it is the path's commenter,
   * never what the body says; the name is the body's `from`, which the
   * store sets. Removed from the inbox once filed (If-Match: a comment
   * changed meanwhile comes again). One that is no comment is kept on this machine and taken out.
   */
  private async takeComment(path: string, version: string) {
    if (this.readOnly) return
    const commenter = INBOX.exec(path)?.[1]
    if (!commenter) return
    // At most this many from one commenter in a round; the rest stay in the inbox for the next.
    const filed = this.filedThisRound.get(commenter) ?? 0
    if (filed >= PER_COMMENTER_ROUND) return this.sayOnce(`flood:${commenter}`, `Many comments from ${commenter} in the store: filing ${PER_COMMENTER_ROUND} a round, the rest wait in the inbox.`)
    this.filedThisRound.set(commenter, filed + 1)
    const r = await this.store.read(path)
    if (!r) return // Another teammate's grndwrk took it.
    try {
      const problem = bytesProblem(path, r.bytes)
      if (problem) throw new BadInput(problem)
      const body = JSON.parse(Buffer.from(r.bytes).toString('utf8')) as unknown
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadInput('it is not a JSON object')
      if (isEnvelope(body)) {
        await this.takeEnvelope(commenter, body)
        this.counts.results++
      } else {
        // Written on the Mac is for a phone that points at its own grndwrk: here nobody's browser is asked to open.
        const { from, on_mac: _onMac, url, ...rest } = body as Record<string, unknown>
        // The name only when the store vouches for it; otherwise the commenter's id, which the path proves.
        const name = this.names && typeof from === 'string' && from.trim() ? from : commenter
        // The address only on the store's staging site, as through the relay: never a local site's, never elsewhere.
        const onSite = typeof url === 'string' && this.site && sameOrigin(url, this.site) ? { url } : {}
        await commentRequest('/api/feedback', { ...rest, ...onSite }, { ...this.ctx, via: 'store', from: { name, commenter }, cardId: cardIdFor(path) })
        this.counts.comments++
      }
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err)
      // Not a comment: kept on this machine, then taken out of the inbox, so it never counts against the
      // commenter's limits for good. Never deleted unseen: the copy and the reason are said.
      if (err instanceof BadInput || err instanceof SyntaxError) {
        const kept = await this.keep(path, r.bytes)
        this.log(`${path} in the store is not a comment grndwrk can file (${said}). Taken out of the inbox; kept at ${kept}`)
        await this.store.remove(path, r.version)
        return
      }
      // Failed here (the disk?): tried again, five times, then left in the inbox.
      const tries = (this.inboxTries.get(path) ?? 0) + 1
      this.inboxTries.set(path, tries)
      if (tries >= 5) return this.sayOnce(`${path}@${version}`, `A comment from ${commenter} in the store could not be filed after ${tries} tries (${said}). It stays in the inbox.`)
      this.log(`A comment from ${commenter} in the store, tried again shortly: ${said}`)
      throw err
    }
    this.inboxTries.delete(path)
    // Filed: removed with If-Match. A comment changed meanwhile stays, and comes again.
    await this.store.remove(path, r.version)
  }

  /**
   * A device tested a fix, or deleted a comment: `{ path, body, at? }`, as
   * the relay's envelopes. It acts only on comments filed from its own
   * folder (`store_commenter`), and only by their keys, whatever ids it
   * names. A test result must name the round it tested: one for another
   * round, or made before the fix was built, settles nothing.
   */
  private async takeEnvelope(commenter: string, { path, body, at }: Envelope) {
    const list = (body as { comments?: unknown })?.comments
    if (!Array.isArray(list)) throw new BadInput('Send { comments: [{ id, key }] }')
    const nodes = await this.ctx.store.list()
    const mine = new Set(nodes.filter((n) => n.extra?.store_commenter === commenter).map((n) => n.id))
    let own = list.filter((c) => mine.has((c as { id?: unknown })?.id as string))
    if (path === '/api/feedback/tested') {
      // The round as fixRound makes it, and when the result was made: without both, it settles nothing.
      if (typeof at !== 'number' || !Number.isFinite(at)) return
      own = own.filter((c) => /^[0-9a-f]{16}$/.test(String((c as { round?: unknown })?.round ?? '')))
      // A day of slack: built dates are written by the map (UTC) and by agents (their own day).
      const made = new Date(at + 86_400_000).toISOString().slice(0, 10)
      const built = new Map(nodes.map((n) => [n.id, typeof n.extra?.built === 'string' ? n.extra.built : '']))
      own = own.filter((c) => (built.get((c as { id: string }).id) ?? '') <= made)
    }
    if (!own.length) return
    // Show on my Mac is not offered through a store: nobody's map is asked to open anything.
    const { on_mac: _onMac, ...rest } = body as Record<string, unknown>
    await commentRequest(path, { ...rest, comments: own }, { ...this.ctx, via: 'store', from: { name: commenter, commenter } })
  }

  /** Each commenter's own comments, as `feedbackStatus` tells a device, written only when it changed. */
  private async sendStatus() {
    if (this.readOnly) return
    const nodes = await this.ctx.store.list()
    const by = new Map<string, { id: string; key: string }[]>()
    for (const n of nodes) {
      const c = n.extra?.store_commenter
      if (typeof c !== 'string' || !COMMENTER.test(c) || typeof n.extra?.key !== 'string') continue
      by.set(c, [...(by.get(c) ?? []), { id: n.id, key: String(n.extra.key) }])
    }
    for (const [commenter, own] of by) {
      const keys = new Map(own.map((o) => [o.id, o.key]))
      const status = await feedbackStatus(this.ctx.store, { comments: own })
      const bytes = Buffer.from(`${JSON.stringify({ comments: status.map((s) => ({ ...s, key: keys.get(s.id) })) })}\n`)
      const hash = hashOf(bytes)
      if (this.statusSent.get(commenter) === hash) continue
      const path = `status/${commenter}.json`
      const there = await this.store.read(path)
      if (there && hashOf(there.bytes) === hash) {
        this.statusSent.set(commenter, hash)
        continue
      }
      const w = await this.store.write(path, bytes, there ? { type: 'application/json', ifVersion: there.version } : { type: 'application/json', create: true })
      // Someone else's grndwrk wrote it at that moment: the next round compares again.
      if (w.ok) this.statusSent.set(commenter, hash)
    }
  }

  private async afterBatch() {
    // New cards from the inbox (and their pictures) go to the store at once.
    if (this.counts.comments || this.counts.results) await this.scan()
    await this.save()
    await this.sendStatus()
  }

  // Running

  /** Keep syncing while grndwrk runs: long polls for the store's changes, and a scan of the folder now and then. */
  start() {
    if (this.running) return
    this.running = true
    void this.loop()
    this.scanTimer = setInterval(() => this.pushLocal().catch((err) => this.fail(err)), this.options.scanEvery ?? 60_000)
    this.scanTimer.unref()
  }

  stop() {
    this.running = false
    clearInterval(this.scanTimer)
    clearTimeout(this.debounce)
  }

  private async loop() {
    let pause = 0
    while (this.running) {
      try {
        const stop = await this.options.stillAllowed?.()
        if (stop) {
          this.log(`${stop}\nSyncing with the store stopped. The map is served from .grndwrk as it is.`)
          this.stop()
          return
        }
        const c = await this.pull(25)
        if (c.pulled || c.deletedHere || c.comments || c.results) this.log(`From the store: ${describe(c)}.`)
        if (this.error) this.log('The store answers again.')
        this.error = undefined
        pause = 0
      } catch (err) {
        this.fail(err)
        pause = Math.min(60_000, pause ? pause * 2 : 2_000)
        await sleep(pause)
      }
    }
  }

  private fail(err: unknown) {
    const said = err instanceof Error ? err.message : String(err)
    if (said !== this.error) this.log(`The store: ${said}`)
    this.error = said
  }

  private sayOnce(path: string, line: string) {
    if (this.said.get(path) === line) return
    this.said.set(path, line)
    this.log(line)
  }
}

/** What a round did, in words: "2 files pulled, 1 comment filed". Empty when nothing. */
export function describe(c: SyncCounts): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  return [
    c.pulled && `${n(c.pulled, 'file')} pulled`,
    c.pushed && `${n(c.pushed, 'file')} pushed`,
    c.deletedHere && `${n(c.deletedHere, 'file')} deleted here`,
    c.deletedThere && `${n(c.deletedThere, 'file')} deleted in the store`,
    c.conflicts && `${n(c.conflicts, 'conflict')} kept`,
    c.comments && `${n(c.comments, 'comment')} filed`,
    c.results && `${n(c.results, 'test result or delete', 'test results and deletes')} from devices`,
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * For `grndwrk start`: the project's store (.grndwrk/store.json), opened and
 * synced once before the map is served. Undefined without a store, or when
 * it cannot be used (no token, an adapter not allowed): then the map is the
 * folder as it is, and the reason is said.
 */
export async function connectStore(gwDir: string, ctx: CommentsCtx, project: string, log: (line: string) => void = (l) => console.log(l)): Promise<StoreSync | undefined> {
  const root = dirname(gwDir)
  const without = 'The map is served from .grndwrk as it is, without syncing.'
  let config: Awaited<ReturnType<typeof readStoreConfig>>
  let client: StoreClient | null
  try {
    config = await readStoreConfig(gwDir)
    if (!config) return undefined
    client = await openStore(root, gwDir, project)
  } catch (err) {
    log(`${err instanceof Error ? err.message : String(err)}\n${without}`)
    return undefined
  }
  if (!client) return undefined
  const where = 'url' in config ? config.url : config.adapter
  const adapter = 'adapter' in config ? config.adapter : ''
  const sync = new StoreSync(gwDir, client, ctx, {
    log,
    identity: 'url' in config ? config.url : `adapter:${config.adapter}`,
    // A pull may change the adapter: it is not run again until allowed again.
    stillAllowed: adapter
      ? async () => {
          const state = await adapterState(root, adapter).catch(() => 'never' as const)
          if (state === 'allowed') return null
          return state === 'changed' ? `The store adapter ${adapter} changed since it was allowed. Read what changed (git diff), then run: grndwrk store allow` : `The store adapter ${adapter} is not allowed on this machine. Read it, then run: grndwrk store allow`
        }
      : undefined,
  })
  try {
    const c = await sync.fullPass()
    log(`Synced with the store at ${where}: ${describe(c) || 'nothing new'}.${c.conflicts ? ` Your side of each conflict is kept in ${sync.conflictsDir()}` : ''}`)
  } catch (err) {
    if (err instanceof NotForSync) {
      log(`${err.message}\n${without}`)
      return undefined
    }
    log(`Could not sync with the store at ${where}: ${err instanceof Error ? err.message : String(err)}\nThe map is served from .grndwrk as it is; grndwrk keeps trying.`)
  }
  return sync
}

/**
 * The card an inbox comment becomes, the same on every machine: two teammates
 * filing it at once write the same file, and the store keeps one (the other's
 * create gets 412). Six letters and digits from a hash of the path.
 */
export function cardIdFor(path: string): string {
  const digest = createHash('sha256').update(`grndwrk-inbox:${path}`).digest()
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return `n_${[...digest.subarray(0, 6)].map((b) => abc[b % abc.length]).join('')}`
}

/** What a device sends besides a comment, as through the relay. Show on my Mac is not among them. */
export const ENVELOPE_PATHS = ['/api/feedback/tested', '/api/feedback/remove']
interface Envelope {
  path: string
  body: unknown
  at?: unknown
}

/**
 * An inbox file is a comment (the `/api/feedback` JSON) or an envelope
 * `{ path, body }`. One that names a path but no other is no comment either:
 * refused, never filed as one.
 */
function isEnvelope(v: object): v is Envelope {
  if (!('path' in v)) return false
  const { path, body } = v as Envelope
  if (typeof path !== 'string' || !ENVELOPE_PATHS.includes(path)) throw new BadInput('it names something a device does not send through the store')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadInput('its body is not a JSON object')
  return true
}

/** Comments filed from one commenter in one round of the sync. */
const PER_COMMENTER_ROUND = 50

function sameOrigin(url: string, site: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === site && !u.username && !u.password
  } catch {
    return false
  }
}
