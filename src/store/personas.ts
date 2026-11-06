import { LinkRefused, mkdir, readdir, readFile, rename, unlink, writeFile } from './fs.js'
import { join } from 'node:path'
import { readMatter } from './matter.js'
import { scalar, today } from './frontmatter.js'
import { newId } from './nodes.js'
import { setField } from './stories.js'
import { readEntryFiles, removeEntries, saveBody, withEntries } from './threads.js'
import { listScreens, updateScreen } from './screens.js'
import { readSections, sameName, writeSections } from '../shared/personas.js'
import { replaceNotes, splitBody } from '../shared/thread.js'
import { PERSONA_CHOICES, PERSONA_FIELDS, PERSONA_LISTS, PERSONA_SECTIONS, SEGMENT_HOW, type Persona, type PersonaField, type PersonaInSegment, type PersonaSection } from '../shared/types.js'

/**
 * Personas: the people the product is for, one file each in `personas/`.
 *
 *   ---
 *   id: pe_k2m4ab
 *   name: Clinic coordinator
 *   summary: Runs the clinic's day, and the product with it.
 *   tier: primary
 *   employer: [customer]
 *   technical: low
 *   frequency: daily
 *   themes: [scheduling, permissions, login]
 *   segments:
 *     sg_chain: {how: most, titles: [Clinic coordinator, Practice manager]}
 *   source: data
 *   created: 2026-10-22
 *   ---
 *   ## Jobs
 *   ...
 *
 * Only the lines that change are written, so two people editing different
 * fields on their own branches still merge. Thread entries go to files of
 * their own, as for cards and screens.
 */
const ID = /^pe_[A-Za-z0-9_-]{1,60}$/
export const isPersonaId = (id: string) => ID.test(id)

export async function listPersonas(gwDir: string): Promise<Persona[]> {
  const dir = join(gwDir, 'personas')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: Persona[] = []
  for (const file of files) {
    const id = file.slice(0, -3)
    if (!ID.test(id)) {
      out.push({ ...empty(id), error: `The file name must be pe_ and letters or digits, like pe_k2m4ab.md, not ${file}.` })
      continue
    }
    try {
      out.push(await withThread(gwDir, parsePersona(id, await readFile(join(dir, file), 'utf8'))))
    } catch (err) {
      if (err instanceof LinkRefused) out.push({ ...empty(id), error: err.message })
      // Otherwise deleted while reading.
    }
  }
  return out
}

export function parsePersona(id: string, raw: string): Persona {
  let data: Record<string, unknown>
  let content: string
  try {
    const parsed = readMatter(raw)
    data = parsed.data
    content = parsed.content
  } catch (err) {
    return { ...empty(id), body: raw, error: `The frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` }
  }
  if (!Object.keys(data).length) return { ...empty(id), body: raw, error: 'No frontmatter: the file must start with a --- line, the fields, and another --- line.' }
  const { rest: _, ...sections } = readSections(splitBody(content).notes)
  return {
    ...sections,
    id,
    name: text(data.name) || id,
    summary: text(data.summary),
    tier: text(data.tier),
    technical: text(data.technical),
    frequency: text(data.frequency),
    learning_curve: text(data.learning_curve),
    ...(Object.fromEntries(PERSONA_LISTS.map((k) => [k, list(data[k])])) as Record<(typeof PERSONA_LISTS)[number], string[]>),
    segments: segmentsOf(data.segments),
    confirmed: date(data.confirmed),
    source: text(data.source),
    seen_in: list(data.seen_in),
    from: list(data.from),
    edited: list(data.edited).filter((f): f is PersonaField => (PERSONA_FIELDS as readonly string[]).includes(f)),
    created: date(data.created),
    body: content,
  }
}

export type PersonaEdit = Partial<Record<Exclude<PersonaField, (typeof PERSONA_LISTS)[number] | 'segments'>, string>> &
  Partial<Record<(typeof PERSONA_LISTS)[number], string[]>> & {
  /** Per segment id: how common, and the titles. A segment left out is taken off. */
  segments?: Record<string, PersonaInSegment>
  /** The person confirms a guess (true), or takes that back. */
  confirmed?: boolean
  /** The notes and thread, as the map sends them back with a new entry. */
  body?: string
}

/**
 * Change a persona from the map. Every field changed is marked as the
 * person's (`edited:`), so /personas leaves it alone. A new name is carried
 * into the screens that named the old one in `for:`.
 */
export async function updatePersona(gwDir: string, id: string, edit: PersonaEdit): Promise<Persona | null> {
  if (!ID.test(id)) return null
  const path = join(gwDir, 'personas', `${id}.md`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const before = parsePersona(id, raw)
  if (before.error) throw new Error(`personas/${id}.md cannot be read: ${before.error}`)
  const m = /^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/.exec(raw.replace(/\r\n?/g, '\n'))
  if (!m) throw new Error(`personas/${id}.md has no frontmatter`)
  let front = m[1] + '\n'
  let content = raw.replace(/\r\n?/g, '\n').slice(m[0].length)
  const edited = new Set(before.edited)
  const name = edit.name?.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (name && name !== before.name) {
    front = setField(front, 'name', scalar(name))
    edited.add('name')
  }
  for (const k of ['summary', ...(Object.keys(PERSONA_CHOICES) as (keyof typeof PERSONA_CHOICES)[])] as const) {
    const value = edit[k]?.trim().replace(/\s*\n\s*/g, ' ')
    if (value === undefined || value === before[k]) continue
    front = setField(front, k, value ? scalar(value) : null)
    edited.add(k)
  }
  for (const k of PERSONA_LISTS) {
    const value = edit[k]?.map((x) => x.trim()).filter(Boolean)
    if (value === undefined || value.join('\n') === before[k].join('\n')) continue
    front = setField(front, k, value.length ? inline(value) : null)
    edited.add(k)
  }
  if (edit.segments !== undefined) {
    const next = Object.entries(edit.segments)
      .map(([id, v]) => [id, { how: howOf(v.how), titles: v.titles.map((t) => t.trim()).filter(Boolean) }] as const)
      .filter(([id, v]) => /^sg_[A-Za-z0-9_-]{1,60}$/.test(id) && (v.how || v.titles.length))
    if (JSON.stringify(Object.fromEntries(next)) !== JSON.stringify(before.segments)) {
      const lines = next.map(([id, v]) => `  ${id}: {how: ${scalar(v.how || 'present')}, titles: ${inline(v.titles)}}`)
      front = setField(front, 'segments', lines.length ? `\n${lines.join('\n')}` : null)
      edited.add('segments')
    }
  }
  if (edit.confirmed !== undefined && edit.confirmed !== !!before.confirmed) front = setField(front, 'confirmed', edit.confirmed ? today() : null)
  if (edit.body !== undefined) content = await saveBody(gwDir, id, content, edit.body)
  const sections: Partial<Record<PersonaSection, string>> = {}
  for (const k of PERSONA_SECTIONS) {
    if (edit[k] !== undefined && edit[k]!.trim() !== before[k]) {
      sections[k] = edit[k]!
      edited.add(k)
    }
  }
  if (Object.keys(sections).length) {
    const notes = writeSections(splitBody(content).notes, sections)
    // Before a thread, the notes end without a newline: replaceNotes puts one blank line between.
    content = /^## Thread\s*$/m.test(content) ? replaceNotes(content, notes.replace(/\n+$/, '')) : notes
  }
  if (edited.size !== before.edited.length) front = setField(front, 'edited', `[${PERSONA_FIELDS.filter((f) => edited.has(f)).join(', ')}]`)
  const next = `---\n${front.replace(/\n$/, '')}\n---\n${content}`
  if (next !== raw) await writeFile(path, next)
  if (name && name !== before.name) await renameInScreens(gwDir, before.name, name)
  return withThread(gwDir, parsePersona(id, await readFile(path, 'utf8')))
}

/** A new persona from the map: a name is enough, and it is the person's. */
export async function createPersona(gwDir: string, input: { name: string; summary?: string }): Promise<Persona> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!name) throw new Error('A persona needs a name')
  const taken = (await listPersonas(gwDir)).find((p) => sameName(p.name, name))
  if (taken) throw new Error(`There is already a persona called ${taken.name}`)
  const dir = join(gwDir, 'personas')
  await mkdir(dir, { recursive: true })
  const id = newId('pe_')
  const summary = input.summary?.trim() ?? ''
  const text = `---\nid: ${id}\nname: ${scalar(name)}\nsummary: ${scalar(summary)}\nedited: [name${summary ? ', summary' : ''}]\ncreated: ${today()}\n---\n`
  const tmp = join(dir, `.${id}.md.tmp`)
  await writeFile(tmp, text, { flag: 'wx' })
  await rename(tmp, join(dir, `${id}.md`))
  return parsePersona(id, text)
}

/** Remove a persona and its thread. Screens keep the name in `for:`, as plain words. */
export async function deletePersona(gwDir: string, id: string): Promise<boolean> {
  if (!ID.test(id)) return false
  try {
    await unlink(join(gwDir, 'personas', `${id}.md`))
  } catch {
    return false
  }
  await removeEntries(gwDir, id)
  return true
}

/**
 * A name in screens' `for:` that is no persona, settled everywhere at once:
 * made a persona of its own, written as an existing persona's name, or taken
 * off. Returns the persona it now links to, if any.
 */
export async function settleAudienceName(gwDir: string, name: string, to: { persona: string } | 'new' | 'remove'): Promise<Persona | null> {
  if (to === 'new') return createPersona(gwDir, { name })
  if (to === 'remove') {
    for (const s of await listScreens(gwDir)) {
      if (s.error || !s.audience.some((a) => sameName(a, name))) continue
      await updateScreen(gwDir, s.id, { audience: s.audience.filter((a) => !sameName(a, name)) })
    }
    return null
  }
  const target = (await listPersonas(gwDir)).find((p) => p.id === to.persona && !p.error)
  if (!target) throw new Error('No such persona')
  await renameInScreens(gwDir, name, target.name)
  return target
}

/** Screens that named the persona by its old name now name it by its new one; a screen that already names it keeps it once. */
async function renameInScreens(gwDir: string, from: string, to: string): Promise<void> {
  for (const s of await listScreens(gwDir)) {
    if (s.error || !s.audience.some((a) => sameName(a, from))) continue
    const next = s.audience.map((a) => (sameName(a, from) ? to : a))
    await updateScreen(gwDir, s.id, { audience: next.filter((a, i) => next.findIndex((b) => sameName(a, b)) === i) })
  }
}

async function withThread(gwDir: string, p: Persona): Promise<Persona> {
  if (p.error) return p
  return { ...p, body: withEntries(p.body, await readEntryFiles(gwDir, p.id)) }
}

function empty(id: string): Persona {
  return {
    ...(Object.fromEntries(PERSONA_SECTIONS.map((k) => [k, ''])) as Record<PersonaSection, string>),
    id, name: id, summary: '', tier: '', technical: '', frequency: '', learning_curve: '',
    employer: [], device: [], lives_in: [], visits: [], themes: [], segments: {},
    confirmed: '', source: '', seen_in: [], from: [], edited: [], created: '', body: '',
  }
}

/** `segments:` as written: a map of segment id to {how, titles}, or to just how. */
function segmentsOf(v: unknown): Record<string, PersonaInSegment> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, PersonaInSegment> = {}
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    // Only segment ids: a key like __proto__ from a file would otherwise reshape the object.
    if (!/^sg_[A-Za-z0-9_-]{1,60}$/.test(id)) continue
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { how: raw }
    out[id] = { how: howOf(o.how), titles: list(o.titles) }
  }
  return out
}

/** most, common, present or none; anything else (from a file or the map) is empty. */
function howOf(v: unknown): string {
  const how = text(v).toLowerCase()
  return (SEGMENT_HOW as readonly string[]).includes(how) ? how : ''
}

/** A list on one line; an item with a comma or bracket in it is quoted. */
function inline(xs: string[]): string {
  return `[${xs.map((x) => (/[,[\]{}]/.test(x) ? JSON.stringify(x) : scalar(x))).join(', ')}]`
}

function date(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : text(v)
}

function text(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : []
}
