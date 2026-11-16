import { bytesProblem, CursorGone, type Change, type Changes, type Hello, pathProblem, PROTOCOL, type Read, type StoreClient, typeOf, type Written } from './protocol.js'

/**
 * A store in memory: the protocol's meaning in a few lines, for tests and
 * as the reference the example stores are checked against. Every write gets
 * a new version from one counter; the changes log keeps each path's latest
 * state, so a cursor is just a position in it.
 */
export class MemoryStore implements StoreClient {
  private files = new Map<string, { bytes: Uint8Array; version: string; type: string }>()
  /** The latest change per path, in the order they happened. */
  private log: { at: number; change: Change }[] = []
  private clock = 0
  private waiters: (() => void)[] = []

  constructor(
    private project = 'Test',
    private writable = true,
    /** How many changes one answer holds at most, to test `more`. */
    private page = 500,
  ) {}

  async hello(): Promise<Hello> {
    return { protocol: PROTOCOL, project: this.project, writable: this.writable }
  }

  async changes({ since, wait = 0 }: { since?: string; wait?: number } = {}): Promise<Changes> {
    if (since === undefined || since === '') {
      const all = [...this.files].map(([path, f]) => ({ path, version: f.version }))
      return { cursor: `c_${this.clock}`, changes: all }
    }
    const from = /^c_(\d+)$/.exec(since)
    if (!from || Number(from[1]) > this.clock) throw new CursorGone(since)
    let after = this.log.filter((e) => e.at > Number(from[1]))
    if (!after.length && wait > 0) {
      await new Promise<void>((done) => {
        const t = setTimeout(done, Math.min(wait, 25) * 1000)
        this.waiters.push(() => (clearTimeout(t), done()))
      })
      after = this.log.filter((e) => e.at > Number(from[1]))
    }
    const page = after.slice(0, this.page)
    const cursor = page.length ? `c_${page[page.length - 1].at}` : since
    return { cursor, changes: page.map((e) => e.change), more: after.length > page.length }
  }

  async read(path: string): Promise<Read | null> {
    if (pathProblem(path)) throw new Error(pathProblem(path))
    const f = this.files.get(path)
    return f ? { bytes: f.bytes, version: f.version, type: f.type } : null
  }

  async write(path: string, bytes: Uint8Array, { create, ifVersion }: { type: string; create?: boolean; ifVersion?: string }): Promise<Written> {
    const problem = pathProblem(path) || bytesProblem(path, bytes)
    if (problem) throw new Error(problem)
    if (!this.writable) throw new Error('This token may not write')
    const there = this.files.get(path)
    if (create ? there : !there || there.version !== ifVersion) return { ok: false, version: there?.version ?? null }
    const version = `v${++this.clock}`
    this.files.set(path, { bytes: new Uint8Array(bytes), version, type: typeOf(path) })
    this.record({ path, version })
    return { ok: true, version }
  }

  async remove(path: string, ifVersion: string) {
    if (pathProblem(path)) throw new Error(pathProblem(path))
    if (!this.writable) throw new Error('This token may not write')
    const there = this.files.get(path)
    if (!there) return { ok: false as const, version: null, gone: true as const }
    if (there.version !== ifVersion) return { ok: false as const, version: there.version }
    this.files.delete(path)
    this.clock++
    this.record({ path, deleted: true })
    return { ok: true as const, version: '' }
  }

  private record(change: Change) {
    // Each path once, at its latest change.
    this.log = this.log.filter((e) => e.change.path !== change.path)
    this.log.push({ at: this.clock, change })
    for (const w of this.waiters.splice(0)) w()
  }
}
