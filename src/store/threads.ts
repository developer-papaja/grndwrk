import { randomInt } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from './fs.js'
import { join } from 'node:path'
import { readMatter } from './matter.js'
import { replaceNotes, splitBody, type Entry, type Who } from '../shared/thread.js'

/**
 * Thread entries in files of their own: `.grndwrk/threads/<card or screen
 * id>/<Unix ms>-<2 chars>.md`, each with who wrote it and when. A new answer
 * or question is a new file, so two people adding to the same thread on their
 * own branches never conflict in git, and the card's own file stays as it was.
 *
 *   ---
 *   who: claude-asks
 *   date: 2026-10-14
 *   ---
 *   Which screen is this about?
 *
 * A thread written inside the card's file, as older maps have it, is read
 * too. In memory the two are one thread, in date order, at the end of the
 * body, so nothing else has to know.
 */
const ENTRY_FILE = /^(\d{9,13})-[a-z0-9]{2}\.md$/
const WHO: Who[] = ['you', 'claude', 'claude-asks']
const LABELS: Record<Who, string> = { you: 'You', claude: 'Claude', 'claude-asks': 'Claude asks' }
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface EntryFile extends Omit<Entry, 'open'> {
  file: string
}

const folder = (gwDir: string, owner: string) => join(gwDir, 'threads', owner)

/** The entry files of one card or screen, oldest first. Files that cannot be read are skipped. */
export async function readEntryFiles(gwDir: string, owner: string): Promise<EntryFile[]> {
  const files = (await readdir(folder(gwDir, owner)).catch(() => [] as string[])).filter((f) => ENTRY_FILE.test(f)).sort()
  const out: EntryFile[] = []
  for (const file of files) {
    try {
      const { data, content } = readMatter(await readFile(join(folder(gwDir, owner), file), 'utf8'))
      const who = String(data.who ?? '').trim().toLowerCase() as Who
      if (!WHO.includes(who) || !content.trim()) continue
      out.push({ file, who, date: String(data.date ?? '').trim(), text: fromEntryFile(content.trim()) })
    } catch {
      // Unreadable or deleted while reading: left out, never shown half.
    }
  }
  return out
}

/** The body the map sees: the card's own body, then every entry file, as one thread in date order. */
export function withEntries(fileBody: string, entries: EntryFile[]): string {
  if (!entries.length) return fileBody
  const { notes, entries: inFile } = splitBody(fileBody)
  // In-file entries first within a day: they are the older way of writing.
  const all = [...inFile.map((e, i) => ({ e, i, at: e.date })), ...entries.map((e, i) => ({ e, i: inFile.length + i, at: e.date }))]
  all.sort((a, b) => (a.at && b.at && a.at !== b.at ? a.at.localeCompare(b.at) : a.i - b.i))
  const thread = all.map(({ e }) => `**${LABELS[e.who]}** · ${e.date}\n${e.text}`).join('\n\n')
  return `${notes.trim() ? `${notes.replace(/\n+$/, '')}\n\n` : ''}## Thread\n\n${thread}\n`
}

const same = (a: Pick<Entry, 'who' | 'date' | 'text'>, b: Pick<Entry, 'who' | 'date' | 'text'>) =>
  a.who === b.who && a.date === b.date && a.text.trim() === b.text.trim()

/**
 * Save a body the map sends back. New entries at the end of its thread go to
 * files of their own; the card's file keeps its thread as it was and takes the
 * new notes. Returns the body to write into the card's file. When the thread
 * was changed rather than added to (never by the map, maybe by hand), the
 * whole body goes into the card's file and the entry files are folded into it.
 */
export async function saveBody(gwDir: string, owner: string, fileBody: string, next: string): Promise<string> {
  const files = await readEntryFiles(gwDir, owner)
  const before = splitBody(withEntries(fileBody, files)).entries
  const { notes, entries } = splitBody(next)
  // A map tab that has not seen the newest entries yet sends fewer: those it
  // sent still match, so its notes are saved and the entries it missed stay.
  const shared = Math.min(before.length, entries.length)
  const kept = before.slice(0, shared).every((e, i) => same(e, entries[i]))
  if (!kept) {
    await rm(folder(gwDir, owner), { recursive: true, force: true })
    return next
  }
  const added = entries.slice(before.length)
  if (added.length) await mkdir(folder(gwDir, owner), { recursive: true })
  // After the newest entry, even one named later than the clock says (written
  // by hand or by an agent that guessed the time): an answer always comes
  // after the question it answers.
  const newest = files.reduce((max, f) => Math.max(max, Number(ENTRY_FILE.exec(f.file)?.[1] ?? 0)), 0)
  let ms = Math.max(Date.now(), newest + 1)
  for (const e of added) {
    const name = `${ms++}-${ALPHABET[randomInt(36)]}${ALPHABET[randomInt(36)]}.md`
    const tmp = join(folder(gwDir, owner), `.${name}.tmp`)
    await writeFile(tmp, `---\nwho: ${e.who}\ndate: ${e.date || new Date().toISOString().slice(0, 10)}\n---\n${toEntryFile(e.text.trim())}\n`, 'utf8')
    await rename(tmp, join(folder(gwDir, owner), name))
  }
  return replaceNotes(fileBody, notes)
}

/**
 * Pictures in a thread entry point at `files/`. In the card's own file that
 * is `../files/<id>/<name>`; an entry file sits one folder deeper, so on disk
 * it says `../../files/...`, and a person or an agent opening the file finds
 * the picture. In memory it reads as in the card, so nothing else has to know.
 */
const toEntryFile = (text: string) => text.replace(/\]\(\.\.\/files\//g, '](../../files/')
const fromEntryFile = (text: string) => text.replace(/\]\(\.\.\/\.\.\/files\//g, '](../files/')

/** A card or screen is gone: so is its thread. */
export async function removeEntries(gwDir: string, owner: string): Promise<void> {
  await rm(folder(gwDir, owner), { recursive: true, force: true })
}
