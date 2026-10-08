/**
 * A node's notes can end in a thread: a short dialog between the person and
 * Claude, kept as plain markdown in the node file.
 *
 *   ## Thread
 *
 *   **Claude asks** · 2026-10-03
 *   Does "not too deep" mean one panel at a time?
 *
 *   **You** · 2026-10-03
 *   Yes.
 *
 * A question is open until any entry comes after it.
 */

export type Who = 'you' | 'claude' | 'claude-asks'

export interface Entry {
  who: Who
  date: string
  text: string
  /** True for a question nobody has answered yet. */
  open: boolean
}

const LABELS: Record<Who, string> = { you: 'You', claude: 'Claude', 'claude-asks': 'Claude asks' }
const HEADING = /^##\s+thread\s*$/im
const ENTRY = /^\*\*(claude asks|claude|you)\*\*\s*(?:[·•|-]\s*)?(.*)$/i
/** Notes and thread are always joined by exactly this. */
const GAP = '\n\n'

/** Split a body into its free notes and the raw thread section, if any. */
function parts(body: string): { notes: string; thread: string | null } {
  const m = HEADING.exec(body)
  if (!m) return { notes: body, thread: null }
  let notes = body.slice(0, m.index)
  if (notes.endsWith(GAP)) notes = notes.slice(0, -GAP.length)
  else notes = notes.replace(/\n$/, '')
  return { notes, thread: body.slice(m.index) }
}

export function splitBody(body: string): { notes: string; entries: Entry[] } {
  const { notes, thread } = parts(body)
  return { notes, entries: thread ? parseThread(thread) : [] }
}

function parseThread(section: string): Entry[] {
  const entries: Entry[] = []
  for (const line of section.split('\n').slice(1)) {
    const m = ENTRY.exec(line.trim())
    if (m) {
      const label = m[1].toLowerCase()
      const who: Who = label === 'you' ? 'you' : label === 'claude asks' ? 'claude-asks' : 'claude'
      entries.push({ who, date: m[2].trim(), text: '', open: false })
    } else if (entries.length) {
      const last = entries[entries.length - 1]
      last.text = last.text ? `${last.text}\n${line}` : line
    }
  }
  for (const e of entries) e.text = e.text.trim()
  entries.forEach((e, i) => (e.open = e.who === 'claude-asks' && i === entries.length - 1))
  return entries
}

/**
 * A question from Claude can end in options to pick from:
 *
 *   **Claude asks** · 2026-10-08
 *   Which type scale?
 *
 *   Options:
 *   - 12, 13, 15 and 20, the sizes style.css already uses
 *   - Tailwind's default scale
 *
 * Returns the question without the list, and the options.
 */
export function questionOptions(text: string): { question: string; options: string[] } {
  const m = /^\s*options:\s*$/im.exec(text)
  if (!m) return { question: text.trim(), options: [] }
  const options = text
    .slice(m.index + m[0].length)
    .split('\n')
    .map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1].trim())
    .filter((o): o is string => !!o)
  return { question: text.slice(0, m.index).trim(), options }
}

export function openQuestions(body: string): number {
  return splitBody(body).entries.filter((e) => e.open).length
}

/** Replace the free notes and keep the thread exactly as it was. */
export function replaceNotes(body: string, notes: string): string {
  const { thread } = parts(body)
  if (thread === null) return notes
  return notes ? `${notes}${GAP}${thread}` : thread
}

/** Add an entry at the end of the thread, starting the thread if there is none. */
export function appendEntry(body: string, who: Who, text: string, date: string): string {
  const entry = `**${LABELS[who]}** · ${date}\n${text.trim()}\n`
  const { notes, thread } = parts(body)
  if (thread === null) {
    const start = `## Thread\n\n${entry}`
    return notes.trim() ? `${notes.replace(/\n+$/, '')}${GAP}${start}` : start
  }
  return `${notes ? notes + GAP : ''}${thread.replace(/\n+$/, '')}\n\n${entry}`
}
