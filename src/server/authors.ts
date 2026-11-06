/**
 * Who added each thought, so a team can tell in the map. A thought made in
 * the map gets `by:` with the name in this Mac's git config. Older thoughts,
 * and those that came by git without one, are read from git: whoever
 * committed the file first. Nothing here is ever sent anywhere.
 */
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, out) => resolve(err ? '' : out))
  })

/** The person on this Mac, as git knows them. Read once. */
let me: Promise<string> | undefined
export function gitUser(gwDir: string): Promise<string> {
  me ??= git(dirname(gwDir), ['config', 'user.name']).then((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80))
  return me
}

/** Each node file's first author in git, by node id. Empty outside git. Kept for a minute. */
let cache: { at: number; dir: string; authors: Promise<Record<string, string>> } | undefined
export function firstAuthors(gwDir: string): Promise<Record<string, string>> {
  if (cache && cache.dir === gwDir && Date.now() - cache.at < 60_000) return cache.authors
  const authors = git(gwDir, ['log', '--diff-filter=A', '--no-renames', '--format=%x00%an', '--name-only', '--', 'nodes']).then((out) => {
    const found: Record<string, string> = {}
    // Newest first: the oldest commit that added a file wins.
    for (const block of out.split('\0')) {
      const [name, ...files] = block.split('\n')
      for (const f of files) {
        const m = /(?:^|\/)nodes\/([A-Za-z0-9_-]+)\.md$/.exec(f.trim())
        if (m && name.trim()) found[m[1]] = name.trim().slice(0, 80)
      }
    }
    return found
  })
  cache = { at: Date.now(), dir: gwDir, authors }
  return authors
}
