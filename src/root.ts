import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GW_DIR = '.groundwork'

/** The package root, from either src/ (tsx) or dist/ (built). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Walk up from `start` to the nearest folder that holds `.groundwork/`. */
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
