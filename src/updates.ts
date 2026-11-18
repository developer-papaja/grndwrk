import { existsSync } from 'node:fs'
import { mkdir, readFile as readOwn, rename, writeFile as writeOwn } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { GW_DIR, PACKAGE_ROOT, stateDir } from './root.js'
import { readFile } from './store/fs.js'
import { hash, managedFiles, packageVersion, readInstalled, VERSION_KEY } from './init.js'

/**
 * Two ways a project falls behind, said when grndwrk starts, in the map's
 * Status and by `grndwrk check` (which agents run):
 *
 * - The rules and commands init copied into the project are older than the
 *   grndwrk running now. Agents follow those copies, so until `grndwrk init`
 *   runs again they work by the old rules. Read on this Mac only.
 * - A newer grndwrk is on npm. Asked at most once a day, at start, and never
 *   when turned off (GRNDWRK_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1), in CI,
 *   or when grndwrk runs from its own source. Only the version is asked for;
 *   nothing about the project is sent. grndwrk never updates itself.
 */

/** The files init would update now: written by init and untouched since, but not what this grndwrk ships, or new in this grndwrk. */
export async function outdatedRules(projectRoot: string): Promise<{ files: string[]; installedBy: string | null }> {
  const gw = join(projectRoot, GW_DIR)
  const installed = await readInstalled(gw)
  const files: string[] = []
  for (const f of await managedFiles(projectRoot)) {
    const current = await readFile(f.dest, 'utf8').catch(() => null)
    if (current === f.shipped) continue
    // Missing: new in this grndwrk. One init wrote before and the person deleted stays deleted.
    if (current === null ? !installed[f.key] : installed[f.key] === hash(current)) files.push(relative(projectRoot, f.dest).split('\\').join('/'))
  }
  const by = installed[VERSION_KEY]
  return { files, installedBy: typeof by === 'string' && VERSION.test(by) ? by : null }
}

export function rulesNotice(o: { files: string[]; installedBy: string | null }, current = packageVersion()): string | null {
  if (!o.files.length) return null
  const since = o.installedBy && o.installedBy !== current ? `, installed by grndwrk ${o.installedBy}` : ''
  return `The map's rules and commands for agents are older than this grndwrk (${current}${since}): ${o.files.length} file${o.files.length > 1 ? 's' : ''}. Run grndwrk init in this project to update them; files you changed yourself are kept.`
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const DAY = 24 * 60 * 60 * 1000

/** Why the npm check is not made, or null when it may be. */
export function updateCheckOff(env: NodeJS.ProcessEnv = process.env, root = PACKAGE_ROOT): string | null {
  const set = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  if (set(env.GRNDWRK_NO_UPDATE_CHECK) || set(env.NO_UPDATE_NOTIFIER)) return 'turned off'
  if (set(env.CI)) return 'CI'
  if (existsSync(join(root, '.git'))) return 'running from the source'
  return null
}

export function updateFile(): string {
  // For tests, so they never touch the person's own file.
  return process.env.GRNDWRK_UPDATE_FILE || join(stateDir(), 'update-check.json')
}

async function readCache(file: string): Promise<{ checked: number; latest: string | null }> {
  try {
    const d = JSON.parse(await readOwn(file, 'utf8'))
    return { checked: Number.isFinite(d?.checked) ? d.checked : 0, latest: typeof d?.latest === 'string' && VERSION.test(d.latest) ? d.latest : null }
  } catch {
    return { checked: 0, latest: null }
  }
}

/** The newest grndwrk on npm as last seen, without asking: for the map and `grndwrk check`. */
export async function knownLatest(file = updateFile()): Promise<string | null> {
  if (updateCheckOff()) return null
  return (await readCache(file)).latest
}

/** The newest grndwrk on npm: asked once a day at most, otherwise as last seen. Null when unknown or turned off. */
export async function latestVersion(o: { file?: string; now?: number; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; root?: string } = {}): Promise<string | null> {
  if (updateCheckOff(o.env, o.root)) return null
  const file = o.file ?? updateFile()
  const now = o.now ?? Date.now()
  const cache = await readCache(file)
  if (cache.checked > 0 && now - cache.checked < DAY && now >= cache.checked) return cache.latest
  let latest = cache.latest
  try {
    const res = await (o.fetch ?? fetch)('https://registry.npmjs.org/grndwrk/latest', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const v = (await res.json())?.version
      if (typeof v === 'string' && VERSION.test(v)) latest = v
    }
  } catch {
    // Offline or npm away: ask again tomorrow.
  }
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeOwn(`${file}.tmp`, JSON.stringify({ checked: now, latest }) + '\n')
    await rename(`${file}.tmp`, file)
  } catch {
    // Not kept: asked again next start.
  }
  return latest
}

/** Whether `a` is a later version than `b` (x.y.z; anything after a dash ignored). */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export function npmNotice(latest: string | null, current = packageVersion()): string | null {
  if (!latest || !isNewer(latest, current)) return null
  return `grndwrk ${latest} is out (this is ${current}). Update with npm install -g grndwrk, then run grndwrk init in each project. GRNDWRK_NO_UPDATE_CHECK=1 turns this check off.`
}
