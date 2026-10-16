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
 * A question stays open until the person answers it or Claude moves on with
 * a plain **Claude** entry. Claude can ask several things at once: several
 * **Claude asks** entries in a row, or one entry with several questions, each
 * with its own Options list. Each is a question of its own. A **You** entry
 * that starts with a quoted question answers that one:
 *
 *   **You** · 2026-10-14
 *   > Which screen is this about?
 *
 *   Community
 *
 * A **You** entry without a quote answers every question before it.
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
  const asked = questionsIn(entries)
  entries.forEach((e, i) => (e.open = asked.some((q) => q.entry === i && q.open)))
  return entries
}

/** One question Claude asked, where it is in the thread, and whether it is answered. */
export interface Question {
  /** The entry it is in, and its place among the questions of that entry. */
  entry: number
  index: number
  date: string
  question: string
  options: string[]
  open: boolean
  /** What the person answered, when they did. */
  answer?: string
}

/** Every question in a body's thread, in order, open or answered. */
export function questions(body: string): Question[] {
  return questionsIn(splitBody(body).entries)
}

function questionsIn(entries: Entry[]): Question[] {
  const all: Question[] = []
  entries.forEach((e, i) => {
    const pending = all.filter((q) => q.open)
    if (e.who === 'claude-asks') {
      splitQuestions(e.text).forEach((q, j) => all.push({ entry: i, index: j, date: e.date, ...q, open: true }))
    } else if (e.who === 'claude') {
      // Claude moved on: what it asked before is no longer waiting.
      for (const q of pending) q.open = false
    } else {
      const { quoted, rest } = leadingQuote(e.text)
      const target = quoted ? pending.find((q) => sameQuestion(q.question, quoted)) : undefined
      for (const q of target ? [target] : pending) {
        q.open = false
        q.answer = target ? rest : e.text
      }
    }
  })
  return all
}

/** A **You** entry's leading quote, and the words after it. */
function leadingQuote(text: string): { quoted: string; rest: string } {
  const lines = text.split('\n')
  let n = 0
  while (n < lines.length && /^\s*>/.test(lines[n])) n++
  const quoted = lines.slice(0, n).map((l) => l.replace(/^\s*>\s?/, '')).join(' ').trim()
  return { quoted, rest: lines.slice(n).join('\n').trim() }
}

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9åäöæøüéè]+/g, ' ').trim()

/** The quote names this question: its first line, or enough of it. */
function sameQuestion(question: string, quoted: string): boolean {
  const q = plain(question)
  const a = plain(quoted)
  if (!a) return false
  const first = plain(question.split('\n').find((l) => l.trim()) ?? '')
  return q.includes(a) || a.includes(first) || (a.length >= 20 && q.startsWith(a.slice(0, 20)))
}

/**
 * The questions in one **Claude asks** entry. Each Options list closes the
 * question above it; text after a list starts the next question when it asks
 * something or has options of its own, and is added to the last one otherwise.
 */
export function splitQuestions(text: string): { question: string; options: string[] }[] {
  const out: { question: string; options: string[] }[] = []
  let words: string[] = []
  let options: string[] = []
  let inOptions = false
  const close = () => {
    const question = words.join('\n').trim()
    if (question || options.length) out.push({ question, options })
    words = []
    options = []
    inOptions = false
  }
  for (const line of text.split('\n')) {
    if (/^\s*options:\s*$/i.test(line)) {
      inOptions = true
      continue
    }
    const option = /^\s*[-*]\s+(.+)$/.exec(line)
    if (inOptions && option) {
      options.push(option[1].trim())
      continue
    }
    if (inOptions && !line.trim()) continue
    if (inOptions) close()
    words.push(line)
  }
  close()
  // A closing remark without a question mark or options belongs to the question before it.
  const merged: typeof out = []
  for (const q of out) {
    const last = merged[merged.length - 1]
    if (last && !q.options.length && !q.question.includes('?')) last.question = `${last.question}\n\n${q.question}`.trim()
    else merged.push(q)
  }
  return merged.length ? merged : [{ question: text.trim(), options: [] }]
}

/**
 * Answer one question: a **You** entry that quotes it, so it reads as the
 * answer to that one even when Claude asked several. Without other open
 * questions the quote is left out.
 */
export function appendAnswer(body: string, question: Question, text: string, date: string): string {
  const others = questions(body).filter((q) => q.open && !(q.entry === question.entry && q.index === question.index))
  if (!others.length) return appendEntry(body, 'you', text, date)
  const first = question.question.split('\n').find((l) => l.trim())?.trim() ?? question.question
  return appendEntry(body, 'you', `> ${first}\n\n${text.trim()}`, date)
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

/** How many questions in the thread wait for an answer. */
export function openQuestions(body: string): number {
  return questions(body).filter((q) => q.open).length
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
