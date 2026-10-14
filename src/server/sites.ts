import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerEvent } from '../shared/types.js'
import { isDevOrigin } from './proxy.js'

/**
 * Which local sites may send comments to this project's map. Any page on
 * localhost, `*.test` or `*.localhost` can load the Comment button, so the
 * first comment from a site asks in the map ("clinic-api.test wants to send
 * comments"), the way a phone asks to pair. Another project's dev server, or a
 * script on it, cannot fill this map without the person allowing it.
 *
 * Allowed sites are kept outside the project, in the user's own folder, keyed
 * by the project's path: a file in the repo (and so a pull request) can never
 * allow a site.
 */
const MAX_PENDING = 10
const PENDING_FOR = 10 * 60_000

export function sitesFile(): string {
  // For tests, so they never touch the person's own list.
  if (process.env.GROUNDWORK_SITES_FILE) return process.env.GROUNDWORK_SITES_FILE
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Groundwork') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'groundwork')
  return join(base, 'sites.json')
}

export class Sites {
  private allowed = new Set<string>()
  private trusted: Set<string>
  private pending = new Map<string, number>()
  private full = false
  private denied = new Set<string>()
  private loaded: Promise<void>

  constructor(
    private gwDir: string,
    private onChange: (event: Extract<ServerEvent, { type: 'site:request' | 'site:done' }>) => void,
    /** Allowed without asking: the product's address given with --app this run. */
    trusted: string[] = [],
    private file = sitesFile(),
  ) {
    this.trusted = new Set(trusted)
    for (const t of trusted) this.allowed.add(t)
    this.loaded = this.read().then((all) => {
      for (const o of all[resolve(gwDir)] ?? []) this.allowed.add(o)
    })
  }

  /** The file, keeping only lists of local development addresses: a broken or odd file allows nothing. */
  private async read(): Promise<Record<string, string[]>> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
      const out: Record<string, string[]> = {}
      for (const [key, list] of Object.entries(data)) {
        if (Array.isArray(list)) out[key] = list.filter((o): o is string => typeof o === 'string' && isDevOrigin(o))
      }
      return out
    } catch {
      return {}
    }
  }

  /** Whether the site may send; when it may not yet, the map is asked. */
  async check(origin: string): Promise<'allowed' | 'asked' | 'denied'> {
    await this.loaded
    if (this.allowed.has(origin)) return 'allowed'
    if (this.denied.has(origin)) return 'denied'
    // A question nobody answered in ten minutes is dropped: a page cannot fill the list for good.
    for (const [o, at] of this.pending) if (Date.now() - at > PENDING_FOR) this.pending.delete(o)
    if (!this.pending.has(origin)) {
      if (this.pending.size >= MAX_PENDING) {
        if (!this.full) console.log(`More sites want to send comments than the map shows (${MAX_PENDING}). Answer those first; the rest ask again.`)
        this.full = true
        return 'asked'
      }
      this.full = false
      this.pending.set(origin, Date.now())
      this.onChange({ type: 'site:request', origin })
    }
    return 'asked'
  }

  /** Whether the site was allowed, without asking. */
  async isAllowed(origin: string): Promise<boolean> {
    await this.loaded
    return this.allowed.has(origin)
  }

  list(): string[] {
    return [...this.pending.keys()]
  }

  /** Sites that may send, for the map's list: kept ones, and --app's address for this run. */
  async allowedList(): Promise<{ origin: string; kept: boolean }[]> {
    await this.loaded
    return [...this.allowed].sort().map((origin) => ({ origin, kept: !this.trusted.has(origin) }))
  }

  /** Take a site off the list: its next comment asks again. --app's address stays while it runs. */
  async remove(origin: string): Promise<boolean> {
    await this.loaded
    if (!this.allowed.has(origin) || this.trusted.has(origin)) return false
    this.allowed.delete(origin)
    await this.save((list) => list.filter((o) => o !== origin))
    this.onChange({ type: 'site:done', origin })
    return true
  }

  private async save(change: (list: string[]) => string[]): Promise<void> {
    const all = await this.read()
    const key = resolve(this.gwDir)
    all[key] = change(all[key] ?? [])
    if (!all[key].length) delete all[key]
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 })
    // Each Groundwork its own temporary file, so two maps saving at once never mix.
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.file)
  }

  /** The person answers in the map. Allowed sites are remembered for this project; a no lasts until Groundwork restarts. */
  async answer(origin: string, allow: boolean): Promise<boolean> {
    if (!this.pending.delete(origin)) return false
    if (allow) {
      this.allowed.add(origin)
      await this.save((list) => [...new Set([...list, origin])])
    } else {
      this.denied.add(origin)
    }
    this.onChange({ type: 'site:done', origin })
    return true
  }
}
