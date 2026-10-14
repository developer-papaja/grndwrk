import { readdir, readFile } from './fs.js'
import { join } from 'node:path'

/**
 * Documents a command writes whole (the brief, the readiness report) are a new
 * file per run, named by Unix time and two random characters:
 * `outputs/brief/1792000000-k3.md`. Two people running the same command on
 * their own branches make two different files, which git merges without a
 * conflict. The newest one is the document. A map from before keeps the
 * single file (`outputs/brief.md`), which is read when there is no run yet.
 */
const RUN = /^(\d{9,13})-[a-z0-9]{2}\.(md|json)$/

/** The newest run's file name in a folder, or null when there is none. */
export async function newestRun(folder: string): Promise<string | null> {
  const files = (await readdir(folder).catch(() => [] as string[])).filter((f) => RUN.test(f))
  if (!files.length) return null
  // By time, then by name, so the pick is the same on every machine.
  files.sort((a, b) => Number(RUN.exec(a)![1]) - Number(RUN.exec(b)![1]) || a.localeCompare(b))
  return files[files.length - 1]
}

/** The newest run of a document, or the single file an older map has, or null. */
export async function readRun(folder: string, legacy: string): Promise<string | null> {
  const newest = await newestRun(folder)
  try {
    return await readFile(newest ? join(folder, newest) : legacy, 'utf8')
  } catch {
    return null
  }
}
