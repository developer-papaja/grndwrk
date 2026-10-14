import { appendFile, readFile } from './fs.js'
import { join } from 'node:path'

/** Keep a path inside `.groundwork/` out of git, through `.groundwork/.gitignore`. */
export async function keepOutOfGit(gwDir: string, entry: string): Promise<void> {
  const ignore = join(gwDir, '.gitignore')
  const before = await readFile(ignore, 'utf8').catch(() => '')
  if (before.split('\n').some((l) => l.trim() === entry)) return
  await appendFile(ignore, `${before && !before.endsWith('\n') ? '\n' : ''}${entry}\n`)
}
