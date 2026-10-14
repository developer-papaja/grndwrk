import { readFile, writeFile } from './fs.js'
import { join } from 'node:path'
import { keepOutOfGit } from './gitignore.js'

/**
 * Settings for this project on this machine only, in `.groundwork/local.json`,
 * kept out of git: the port its Groundwork runs on, so it stays the same from
 * one start to the next, and where the product runs here (`--app`).
 */
const file = (gwDir: string) => join(gwDir, 'local.json')

async function read(gwDir: string): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(await readFile(file(gwDir), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export async function rememberedPort(gwDir: string): Promise<number | undefined> {
  const port = (await read(gwDir)).port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

export async function rememberPort(gwDir: string, port: number): Promise<void> {
  await writeFile(file(gwDir), JSON.stringify({ ...(await read(gwDir)), port }, null, 2) + '\n')
  await keepOutOfGit(gwDir, 'local.json')
}

/**
 * Where the product runs on this machine, as `--app` was given last. Each
 * person's can differ (https://shop.test, http://localhost:5173), so it is kept
 * here and not in project.md, where two people would overwrite each other's.
 * An older map may still have `app:` in project.md: that is read too.
 */
export async function rememberedApp(gwDir: string, fallback?: unknown): Promise<string | undefined> {
  const app = (await read(gwDir)).app
  if (isLocalApp(app)) return app
  return isLocalApp(fallback) ? fallback : undefined
}

/**
 * Only an address on this machine is remembered: the files could come from
 * someone else's commit, and the map's Open button must not lead to a site on
 * the internet. An address elsewhere works when given with --app each time.
 */
function isLocalApp(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return /^https?:$/.test(u.protocol) && /^(localhost|127\.0\.0\.1|\[::1\]|.+\.(test|localhost))$/.test(u.hostname)
  } catch {
    return false
  }
}

export async function rememberApp(gwDir: string, app: string): Promise<void> {
  const data = await read(gwDir)
  if (data.app === app) return
  await writeFile(file(gwDir), JSON.stringify({ ...data, app }, null, 2) + '\n')
  await keepOutOfGit(gwDir, 'local.json')
}

/** The port a map tab was open on when Groundwork last stopped, so the next start on that port can leave it to that tab. */
export async function rememberedTab(gwDir: string): Promise<number | undefined> {
  const tab = (await read(gwDir)).tab
  return typeof tab === 'number' ? tab : undefined
}

export async function rememberTab(gwDir: string, port: number | null): Promise<void> {
  const data = await read(gwDir)
  if ((data.tab ?? null) === port) return
  await writeFile(file(gwDir), JSON.stringify({ ...data, tab: port }, null, 2) + '\n')
  await keepOutOfGit(gwDir, 'local.json')
}
