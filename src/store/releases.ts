import { join } from 'node:path'
import { readdir, readFile } from './fs.js'
import { readMatter } from './matter.js'
import { readRelease, RELEASE_ID, type Release, sortReleases } from '../shared/releases.js'

/**
 * The project's releases, from `releases/<id>.md` (src/shared/releases.ts).
 * Written by the agent when it ships, or by /release; the map only reads them.
 * Run by grndwrk on the Mac and by the page on a store alike.
 */
export async function listReleases(gwDir: string): Promise<Release[]> {
  const dir = join(gwDir, 'releases')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md') && RELEASE_ID.test(f.slice(0, -3)))
  } catch {
    return []
  }
  const out: Release[] = []
  for (const file of files) {
    const id = file.slice(0, -3)
    try {
      const m = readMatter(await readFile(join(dir, file), 'utf8'))
      out.push(readRelease(id, m.data, m.content))
    } catch (err) {
      out.push({ id, name: id, date: '', where: '', shipped: [], notes: '', error: `Can't be read: ${(err as Error).message}` })
    }
  }
  return sortReleases(out)
}
