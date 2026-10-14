import * as fs from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/**
 * The file calls Groundwork makes, refusing to follow a symbolic link inside
 * `.groundwork/`. Git stores links, so a pull request could add
 * `.groundwork/threads/n_abc123 -> ../../.claude/commands` or a brief that
 * points at `~/.ssh/id_rsa`; following it would write outside the folder or
 * show any file on this Mac in the map. Every path under a folder named
 * `.groundwork` or `.claude` (where init writes the commands) is checked from
 * that folder down (the folder itself included); paths elsewhere pass through
 * unchanged.
 */
export class LinkRefused extends Error {}

const GUARDED = ['.groundwork', '.claude']

async function check(path: string): Promise<void> {
  const full = resolve(path)
  const parts = full.split(sep)
  // From the outermost guarded folder down: .groundwork, and .claude where
  // init writes the commands. macOS and Windows ignore letter case.
  const fold = process.platform === 'darwin' || process.platform === 'win32'
  const at = parts.findIndex((p) => GUARDED.includes(fold ? p.toLowerCase() : p))
  if (at < 0) return
  for (let i = at; i < parts.length; i++) {
    const p = parts.slice(0, i + 1).join(sep) || sep
    let link: boolean
    try {
      link = (await lstat(p)).isSymbolicLink()
    } catch {
      return // Not there yet: nothing below it exists to follow.
    }
    if (link) throw new LinkRefused(`${parts.slice(at, i + 1).join('/')} is a symbolic link. Groundwork does not follow links inside .groundwork or .claude; replace it with a real file or folder.`)
  }
}

const guard =
  <A extends [string | URL | fs.FileHandle | Buffer, ...unknown[]], R>(f: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    if (typeof args[0] === 'string') await check(args[0])
    return f(...args)
  }

export const readFile = guard(fs.readFile) as typeof fs.readFile
export const writeFile = guard(fs.writeFile) as typeof fs.writeFile
export const appendFile = guard(fs.appendFile) as typeof fs.appendFile
export const readdir = guard(fs.readdir) as typeof fs.readdir
export const mkdir = guard(fs.mkdir) as typeof fs.mkdir
export const stat = guard(fs.stat) as typeof fs.stat
export const unlink = guard(fs.unlink) as typeof fs.unlink
export const chmod = guard(fs.chmod) as typeof fs.chmod
export const rm = guard(fs.rm) as typeof fs.rm

/** Both ends are checked: the folder it leaves and the folder it lands in. */
export async function rename(from: string, to: string): Promise<void> {
  await check(from)
  await check(dirname(to))
  return fs.rename(from, to)
}
