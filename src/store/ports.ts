import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { stateDir } from '../root.js'

/**
 * Which project keeps which ports on this machine, in the user's own folder
 * (never in a project): each project's map port, with the two after it for
 * `--app` and `--lan`. A new project gets ports no other project keeps, even
 * one that is not running now, so two maps never end up wanting the same port.
 * A project is added the first time it starts with this list; one whose
 * folder is gone gives its ports back.
 */
export const FIRST = 7777
/** The map, --app and --lan. */
export const BLOCK = 3

export function portsFile(): string {
  // For tests, so they never touch the person's own list.
  if (process.env.GRNDWRK_PORTS_FILE) return process.env.GRNDWRK_PORTS_FILE
  return join(stateDir(), 'ports.json')
}

/** Every project's port, by the path of its .grndwrk folder. A broken file keeps nothing. */
export async function readPorts(file = portsFile()): Promise<Record<string, number>> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: Record<string, number> = {}
    for (const [dir, port] of Object.entries(data)) {
      if (Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 && existsSync(dir)) out[dir] = port as number
    }
    return out
  } catch {
    return {}
  }
}

/** Keep this project's port in the list. */
export async function keepPort(gwDir: string, port: number, file = portsFile()): Promise<void> {
  const all = await readPorts(file)
  const key = resolve(gwDir)
  if (all[key] === port) return
  all[key] = port
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, file)
}

const overlaps = (a: number, b: number) => a < b + BLOCK && b < a + BLOCK

/** Other projects whose ports overlap this port and the two after it, by their folder name. */
export function clashesWith(all: Record<string, number>, gwDir: string, port: number): string[] {
  const self = resolve(gwDir)
  return Object.entries(all)
    .filter(([dir, p]) => dir !== self && overlaps(p, port))
    .map(([dir]) => basename(dirname(dir)))
}

/**
 * The first port from 7777 where this port and the two after it are kept by
 * no other project, and nothing on this Mac answers on them now.
 */
export async function freePort(all: Record<string, number>, gwDir: string, answers: (port: number) => Promise<boolean>): Promise<number> {
  for (let port = FIRST; port < 65536 - BLOCK; port++) {
    if (clashesWith(all, gwDir, port).length) continue
    let busy = false
    for (let p = port; p < port + BLOCK && !busy; p++) busy = await answers(p)
    if (!busy) return port
  }
  return FIRST
}
