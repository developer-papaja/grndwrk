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
 * A **You** entry without a quote is a remark: it answers no question. The
 * map always quotes the question it answers. Before REMARKS_SINCE an entry
 * without a quote answered every question before it, and older entries are
 * still read that way, so what was answered stays answered.
 */

/** From this day on, a **You** entry without a quote answers nothing. */
export const REMARKS_SINCE = '2026-11-06'

/** Written before remarks existed: a dated entry from before REMARKS_SINCE. */
const answersAll = (date: string) => /^\d{4}-\d{2}-\d{2}/.test(date.trim()) && date.trim().slice(0, 10) < REMARKS_SINCE

export type Who = 'you' | 'claude' | 'claude-asks'

export interface Entry {
  who: Who
  date: string
  text: string
  /** True for a question nobody has answered yet. */
  open: boolean
  /** The entry's own file in `threads/<id>/`, without `.md`: only those can be changed or taken back. */
  run?: string
  /** A changed answer, kept beside the one it replaces: that one's run. */
  replaces?: string
  /** When the person changed it, as an ISO time. */
  changed?: string
  /** Changed after Claude had already replied or asked again below it. */
  afterClaude?: boolean
  /** A Claude entry that took up a changed answer: that answer's run. */
  takesUp?: string
  /** Replaced by a newer answer: shown crossed out, answers nothing. */
  superseded?: boolean
  /** Changed after Claude read it, and not taken up yet. */
  retake?: boolean
}

/**
 * What the map knows about an entry file, carried in memory on the entry's
 * line as an HTML comment: `**You** · 2026-11-09 <!-- run: 1762...-ab; replaces: ... -->`.
 * Only the map's merged body has it; files keep it in their frontmatter.
 */
export type EntryMeta = Pick<Entry, 'run' | 'replaces' | 'changed' | 'afterClaude' | 'takesUp'>

export function metaComment(m: EntryMeta): string {
  const parts = [
    m.run && `run: ${m.run}`,
    m.replaces && `replaces: ${m.replaces}`,
    m.changed && `changed: ${m.changed}`,
    m.afterClaude && 'after_claude: true',
    m.takesUp && `takes_up: ${m.takesUp}`,
  ].filter(Boolean)
  return parts.length ? ` <!-- ${parts.join('; ')} -->` : ''
}

const META = /\s*<!--([^>]*)-->\s*$/
const RUN = /^\d{9,13}-[a-z0-9]{2}$/

function readMeta(header: string): { date: string; meta: EntryMeta } {
  const m = META.exec(header)
  if (!m) return { date: header.trim(), meta: {} }
  const meta: EntryMeta = {}
  for (const pair of m[1].split(';')) {
    const at = pair.indexOf(':')
    if (at < 0) continue
    const key = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (key === 'run' && RUN.test(value)) meta.run = value
    else if (key === 'replaces' && RUN.test(value)) meta.replaces = value
    else if (key === 'takes_up' && RUN.test(value)) meta.takesUp = value
    else if (key === 'changed' && value) meta.changed = value
    else if (key === 'after_claude') meta.afterClaude = value === 'true'
  }
  return { date: header.slice(0, m.index).trim(), meta }
}

/** Strip what the map carries on entry lines, for writing a thread into a file as plain text. */
export function withoutMeta(body: string): string {
  return body.replace(/^(\*\*(?:claude asks|claude|you)\*\*[^\n]*?)\s*<!--[^>]*-->[ \t]*$/gim, '$1')
}

/** Mark answers a newer one replaces, and changed answers Claude has not taken up again. */
function markChanges(entries: Entry[]): void {
  const replaced = new Set(entries.map((e) => e.replaces).filter(Boolean))
  const ms = (run?: string) => (run ? Number(run.split('-')[0]) : NaN)
  for (const e of entries) {
    if (e.run && replaced.has(e.run)) e.superseded = true
    const since = e.changed ? Date.parse(e.changed) : NaN
    // Taken up: a Claude entry written after the change names it.
    const takenUp = entries.some((c) => c.who === 'claude' && !!e.run && c.takesUp === e.run && !(ms(c.run) < since))
    if (e.afterClaude && !e.superseded && !takenUp) e.retake = true
  }
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
      const { date, meta } = readMeta(m[2])
      entries.push({ who, date, text: '', open: false, ...meta })
    } else if (entries.length) {
      const last = entries[entries.length - 1]
      last.text = last.text ? `${last.text}\n${line}` : line
    }
  }
  for (const e of entries) e.text = e.text.trim()
  markChanges(entries)
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
      // An answer the person changed since: the newer one counts.
      if (e.superseded) return
      const { quoted, rest } = leadingQuote(e.text)
      let target = quoted ? pending.find((q) => sameQuestion(q.question, quoted)) : undefined
      // A changed answer answers its question again, even when Claude moved on since.
      if (!target && quoted && e.replaces) target = [...all].reverse().find((q) => sameQuestion(q.question, quoted))
      // A remark, or a quote of something that is not an open question: nothing is answered.
      if (!target && !answersAll(e.date)) return
      for (const q of target ? [target] : pending) {
        q.open = false
        q.answer = target ? rest : e.text
      }
    }
  })
  return all
}

/** A **You** entry's leading quote, and the words after it. */
export function leadingQuote(text: string): { quoted: string; rest: string } {
  const lines = text.split('\n')
  let n = 0
  while (n < lines.length && /^\s*>/.test(lines[n])) n++
  const quoted = lines.slice(0, n).map((l) => l.replace(/^\s*>\s?/, '')).join(' ').trim()
  return { quoted, rest: lines.slice(n).join('\n').trim() }
}

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9åäöæøüéè]+/g, ' ').trim()

/** The quote names this question: its first line, or enough of it. */
export function sameQuestion(question: string, quoted: string): boolean {
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
 * Answer one question: a **You** entry that quotes it. Without the quote the
 * entry would be a remark and answer nothing.
 */
export function appendAnswer(body: string, question: Question, text: string, date: string): string {
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

/**
 * One answer from the options picked and the person's own words. The picks
 * keep the order Claude gave them; one pick is the option itself, several are
 * a list, and the words follow:
 *
 *   - Today
 *   - The last day booked
 *
 *   Whichever is later.
 */
export function answerText(options: string[], picked: string[], words: string): string {
  const chosen = options.filter((o) => picked.includes(o))
  const list = chosen.length > 1 ? chosen.map((o) => `- ${o}`).join('\n') : (chosen[0] ?? '')
  return [list, words.trim()].filter(Boolean).join('\n\n')
}

/**
 * The other way round from answerText: the options picked and the words, to
 * put an answer back in its box to edit it.
 */
export function splitAnswer(options: string[], text: string): { picked: string[]; words: string } {
  const blocks = text.trim().split(/\n\s*\n/)
  const first = blocks[0] ?? ''
  const lines = first.split('\n').map((l) => l.trim())
  const listed = lines.every((l) => /^[-*]\s+/.test(l)) ? lines.map((l) => l.replace(/^[-*]\s+/, '')) : []
  const picked = listed.length > 1 && listed.every((l) => options.includes(l)) ? listed : options.includes(first.trim()) ? [first.trim()] : []
  return { picked, words: (picked.length ? blocks.slice(1) : blocks).join('\n\n').trim() }
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
