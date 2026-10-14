import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerEvent } from '../shared/types.js'

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

export function sitesFile(): string {
  // For tests, so they never touch the person's own list.
  if (process.env.GROUNDWORK_SITES_FILE) return process.env.GROUNDWORK_SITES_FILE
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Groundwork') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'groundwork')
  return join(base, 'sites.json')
}

export class Sites {
  private allowed = new Set<string>()
  private pending = new Map<string, string>()
  private denied = new Set<string>()
  private loaded: Promise<void>

  constructor(
    private gwDir: string,
    private onChange: (event: Extract<ServerEvent, { type: 'site:request' | 'site:done' }>) => void,
    /** Allowed without asking: the product's address given with --app this run. */
    trusted: string[] = [],
    private file = sitesFile(),
  ) {
    for (const t of trusted) this.allowed.add(t)
    this.loaded = this.read().then((all) => {
      for (const o of all[resolve(gwDir)] ?? []) this.allowed.add(o)
    })
  }

  private async read(): Promise<Record<string, string[]>> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  /** Whether the site may send; when it may not yet, the map is asked. */
  async check(origin: string): Promise<'allowed' | 'asked' | 'denied'> {
    await this.loaded
    if (this.allowed.has(origin)) return 'allowed'
    if (this.denied.has(origin)) return 'denied'
    if (!this.pending.has(origin) && this.pending.size < MAX_PENDING) {
      this.pending.set(origin, new Date().toISOString())
      this.onChange({ type: 'site:request', origin })
    }
    return 'asked'
  }

  list(): string[] {
    return [...this.pending.keys()]
  }

  /** The person answers in the map. Allowed sites are remembered for this project; a no lasts until Groundwork restarts. */
  async answer(origin: string, allow: boolean): Promise<boolean> {
    if (!this.pending.delete(origin)) return false
    if (allow) {
      this.allowed.add(origin)
      const all = await this.read()
      const key = resolve(this.gwDir)
      all[key] = [...new Set([...(all[key] ?? []), origin])]
      await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 })
      await writeFile(`${this.file}.tmp`, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
    } else {
      this.denied.add(origin)
    }
    this.onChange({ type: 'site:done', origin })
    return true
  }
}
