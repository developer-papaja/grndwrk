import { PERSONA_SECTIONS, SIZE_BANDS, type Persona, type PersonaSection, type Screen, type Segment } from './types.js'

/**
 * The sections of a persona, in the order they are written, with what each
 * asks about: what a table cannot say, and the evidence it rests on. The rest
 * of a persona is fields. Other headings that mean the same are read too;
 * older ones (Who they are, Context, Lives in) stay as notes.
 */
export const SECTIONS: { key: PersonaSection; heading: string; hint: string; also: string[] }[] = [
  { key: 'jobs', heading: 'Jobs', hint: 'What they come to do, the most frequent first.', also: ['jobs to be done', 'tasks', 'what they want', 'wants', 'goals'] },
  { key: 'first', heading: 'Needs to see first', hint: 'What they must see the moment they arrive, and what it says when nothing needs them.', also: ['sees first', 'needs first'] },
  { key: 'judged_on', heading: 'Judged on', hint: 'What makes them look good or bad at work, and how the product reflects on them.', also: ['judged by'] },
  { key: 'goes_wrong', heading: 'Where it goes wrong', hint: 'Pressure, interruptions, what they forget between visits: what makes it fail for them.', also: ['what gets in the way', 'gets in the way', 'frustrations', 'pains', 'obstacles'] },
  { key: 'implications', heading: 'Design implications', hint: 'What the product should do because of all this.', also: ['implications', 'what it means for the design'] },
  {
    key: 'evidence',
    heading: 'Evidence',
    hint: 'What it rests on, one line each, tagged with the segment and the theme: - [Clinic chains · hardware] An appointment says Conflict. What do I do?',
    also: ['questions they ask', 'quotes'],
  },
]

const key = (s: string) => s.trim().toLowerCase()
const sectionOf = (heading: string) => SECTIONS.find((s) => key(s.heading) === key(heading) || s.also.includes(key(heading)))

/** A name as screens write it in `for:` matches a persona's name, whatever the letter case. */
export const sameName = (a: string, b: string) => key(a) === key(b) && key(a) !== ''

export function personaNamed(name: string, personas: Persona[]): Persona | null {
  return personas.find((p) => !p.error && sameName(p.name, name)) ?? null
}

/** The screens meant for a persona: those that name it in `for:`. */
export function screensForPersona(persona: Persona, screens: Screen[]): Screen[] {
  return screens.filter((s) => s.audience.some((a) => sameName(a, persona.name)))
}

/** Claude's guess until the person confirms it. */
export const isGuess = (p: Persona) => p.source === 'inferred' && !p.confirmed

type Sections = Record<PersonaSection, string>

/**
 * The notes split into the sections and the rest. A section runs to the
 * next `## ` heading; anything else (a `# Name` title, other headings) is
 * notes: `head` before the first section, `tail` after it.
 */
function split(notes: string): Sections & { head: string; tail: string } {
  const out = { ...(Object.fromEntries(PERSONA_SECTIONS.map((k) => [k, ''])) as Sections), head: '', tail: '' }
  const head: string[] = []
  const tail: string[] = []
  let at: (typeof SECTIONS)[number] | undefined
  let seen = false
  let buf: string[] = []
  const flush = () => {
    if (at) out[at.key] = [out[at.key], buf.join('\n').trim()].filter(Boolean).join('\n\n')
    else (seen ? tail : head).push(...buf)
    buf = []
  }
  for (const line of notes.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      flush()
      at = sectionOf(h[1])
      if (at) seen = true
      else (seen ? tail : head).push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  out.head = head.join('\n').trim()
  out.tail = tail.join('\n').trim()
  return out
}

/** The sections, and the other notes as one text. */
export function readSections(notes: string): Sections & { rest: string } {
  const { head, tail, ...sections } = split(notes)
  return { ...sections, rest: [head, tail].filter(Boolean).join('\n\n') }
}

/** The notes with sections changed, in the usual order; other notes stay before or after the sections, where they were. */
export function writeSections(notes: string, change: Partial<Sections>): string {
  const now = { ...split(notes), ...change }
  const parts = [now.head, ...SECTIONS.filter((s) => now[s.key].trim()).map((s) => `## ${s.heading}\n${now[s.key].trim()}`), now.tail]
  const text = parts.filter(Boolean).join('\n\n')
  return text ? text + '\n' : ''
}

/** One line of evidence: what someone asked or said, in which segment, about which themes. */
export interface Evidence {
  /** The segment's id, or empty when the line names none. */
  segment: string
  themes: string[]
  text: string
}

/**
 * The evidence lines of a persona: `- [Clinic chains · hardware] text`.
 * A tag that names a segment (by name or id) is the segment; the others are themes.
 */
export function readEvidence(text: string, segments: Segment[]): Evidence[] {
  const out: Evidence[] = []
  for (const raw of text.split('\n')) {
    // Trimmed first: a lazy match before trailing spaces backtracks quadratically on a crafted line.
    const line = raw.slice(0, 2000).trim()
    const m = /^[-*]\s+(?:\[([^\]]*)\]\s*)?(.+)$/.exec(line)
    if (!m) continue
    const tags = (m[1] ?? '').split(/[·,]/).map((t) => t.trim()).filter(Boolean)
    const seg = tags.map((t) => segments.find((s) => key(s.id) === key(t) || key(s.name) === key(t))).find(Boolean)
    out.push({ segment: seg?.id ?? '', themes: tags.filter((t) => !segments.some((s) => key(s.id) === key(t) || key(s.name) === key(t))).map(key), text: m[2] })
  }
  return out
}

/** Whether a segment's size falls in a band. A segment of unknown size falls in none. */
export function inBand(segment: Segment, band: string): boolean {
  const b = SIZE_BANDS.find(([label]) => label === band)
  if (!b) return true
  if (!segment.size_min && !segment.size_max) return false
  const max = segment.size_max || Infinity
  return segment.size_min <= b[2] && max >= b[1]
}

/** "1 000 to 5 000", "Over 10 000", or empty when not known. */
export function sizeLabel(segment: Segment): string {
  // Thousands apart with a space that never breaks, so 5 000 stays on one line.
  const n = (x: number) => x.toLocaleString('en').replace(/,/g, '\u00a0')
  if (!segment.size_min && !segment.size_max) return ''
  if (!segment.size_max) return `${n(segment.size_min)}+`
  return segment.size_min === segment.size_max ? n(segment.size_min) : `${n(segment.size_min)} to ${n(segment.size_max)}`
}

/** How many evidence lines a persona has per theme, in the segments given (all when null). Listed themes count from 0. */
export function themeCounts(persona: Persona, segments: Segment[], only: Set<string> | null): Map<string, number> {
  const counts = new Map<string, number>(persona.themes.map((t) => [key(t), 0]))
  for (const e of readEvidence(persona.evidence, segments)) {
    if (only && e.segment && !only.has(e.segment)) continue
    for (const t of e.themes) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return counts
}

/** Names in screens' `for:` that are no persona, with the screens that use each. Written by hand or before personas existed. */
export function looseNames(screens: Screen[], personas: Persona[]): { name: string; screens: Screen[] }[] {
  const out: { name: string; screens: Screen[] }[] = []
  for (const s of screens) {
    for (const a of s.audience) {
      if (personaNamed(a, personas)) continue
      const known = out.find((x) => sameName(x.name, a))
      if (known) known.screens.push(s)
      else out.push({ name: a, screens: [s] })
    }
  }
  return out.sort((a, b) => b.screens.length - a.screens.length || a.name.localeCompare(b.name))
}
