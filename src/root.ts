import { existsSync, lstatSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GW_DIR = '.grndwrk'
/** The folder's name before the rename to grndwrk; `init` moves it. */
export const OLD_GW_DIR = '.groundwork'

/** The package root, from either src/ (tsx) or dist/ (built). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Walk up from `start` to the nearest folder that holds `.grndwrk/`. */
export function findProjectRoot(start: string): string | null {
  let dir = start
  while (true) {
    const candidate = join(dir, GW_DIR)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Why no map was found from `start`: none at all, or one from before the rename that `init` moves. */
export function noMapMessage(start: string): string {
  let dir = start
  while (true) {
    const old = join(dir, OLD_GW_DIR)
    if (existsSync(old) && statSync(old).isDirectory()) return `Found ${OLD_GW_DIR}/ in ${dir}, from before the rename to grndwrk. Run \`grndwrk init\` there to move it to ${GW_DIR}/.`
    const parent = dirname(dir)
    if (parent === dir) return `No ${GW_DIR}/ folder found here or in any parent folder. Run \`grndwrk init\` first.`
    dir = parent
  }
}

/**
 * grndwrk's own folder for this user, outside every project: the allowed
 * sites and the logins for screenshots. The folder from before the rename
 * (Groundwork) is moved here the first time, unless it is a link.
 */
export function stateDir(): string {
  const at = (name: string) => (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', name) : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), name))
  const dir = at('grndwrk')
  const old = at(process.platform === 'darwin' ? 'Groundwork' : 'groundwork')
  try {
    if (!existsSync(dir) && lstatSync(old).isDirectory()) renameSync(old, dir)
  } catch {
    // No old folder, or it cannot be moved: start a new one.
  }
  return dir
}
