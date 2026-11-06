import { LinkRefused, mkdir, readdir, readFile, rename, unlink, writeFile } from './fs.js'
import { join } from 'node:path'
import { readMatter } from './matter.js'
import { scalar, today } from './frontmatter.js'
import { newId } from './nodes.js'
import { setField } from './stories.js'
import { readEntryFiles, removeEntries, saveBody, withEntries } from './threads.js'
import { sameName } from '../shared/personas.js'
import type { Segment } from '../shared/types.js'

/**
 * Segments: kinds of customers, one file each in `segments/`, edited in the
 * Personas view or written by /personas.
 *
 *   ---
 *   id: sg_k2m4ab
 *   name: Clinic chains
 *   type: franchise
 *   industry: Veterinary care
 *   size_min: 200
 *   size_max: 2000
 *   admins: [Operations manager, Clinic coordinator, Practice manager]
 *   source: data
 *   created: 2026-10-22
 *   ---
 *   Notes.
 *
 * Only the lines that change are written, so edits merge.
 */
const ID = /^sg_[A-Za-z0-9_-]{1,60}$/

export async function listSegments(gwDir: string): Promise<Segment[]> {
  const dir = join(gwDir, 'segments')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: Segment[] = []
  for (const file of files) {
    const id = file.slice(0, -3)
    if (!ID.test(id)) {
      out.push({ ...empty(id), error: `The file name must be sg_ and letters or digits, like sg_k2m4ab.md, not ${file}.` })
      continue
    }
    try {
      const s = parseSegment(id, await readFile(join(dir, file), 'utf8'))
      out.push(s.error ? s : { ...s, body: withEntries(s.body, await readEntryFiles(gwDir, id)) })
    } catch (err) {
      if (err instanceof LinkRefused) out.push({ ...empty(id), error: err.message })
    }
  }
  return out
}

export function parseSegment(id: string, raw: string): Segment {
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
  return {
    id,
    name: text(data.name) || id,
    type: text(data.type).toLowerCase(),
    industry: text(data.industry),
    size_min: size(data.size_min),
    size_max: size(data.size_max),
    admins: list(data.admins),
    source: text(data.source),
    created: data.created instanceof Date ? data.created.toISOString().slice(0, 10) : text(data.created),
    body: content,
  }
}

export interface SegmentEdit {
  name?: string
  type?: string
  industry?: string
  size_min?: number
  size_max?: number
  admins?: string[]
  /** Notes and thread, as the map sends them back. */
  body?: string
}

export async function updateSegment(gwDir: string, id: string, edit: SegmentEdit): Promise<Segment | null> {
  if (!ID.test(id)) return null
  const path = join(gwDir, 'segments', `${id}.md`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const before = parseSegment(id, raw)
  if (before.error) throw new Error(`segments/${id}.md cannot be read: ${before.error}`)
  const m = /^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/.exec(raw.replace(/\r\n?/g, '\n'))
  if (!m) throw new Error(`segments/${id}.md has no frontmatter`)
  let front = m[1] + '\n'
  let content = raw.replace(/\r\n?/g, '\n').slice(m[0].length)
  const name = edit.name?.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (name && name !== before.name) front = setField(front, 'name', scalar(name))
  for (const k of ['type', 'industry'] as const) {
    const v = edit[k]?.trim().replace(/\s+/g, ' ').slice(0, 120)
    if (v !== undefined && v !== before[k]) front = setField(front, k, v ? scalar(v) : null)
  }
  for (const k of ['size_min', 'size_max'] as const) {
    const v = edit[k]
    if (v !== undefined && v !== before[k]) front = setField(front, k, v > 0 ? String(Math.round(v)) : null)
  }
  if (edit.admins !== undefined) {
    const v = edit.admins.map((x) => x.trim()).filter(Boolean)
    if (v.join('\n') !== before.admins.join('\n')) front = setField(front, 'admins', v.length ? `[${v.map((x) => (/[,[\]{}]/.test(x) ? JSON.stringify(x) : scalar(x))).join(', ')}]` : null)
  }
  if (edit.body !== undefined) content = await saveBody(gwDir, id, content, edit.body)
  const next = `---\n${front.replace(/\n$/, '')}\n---\n${content}`
  if (next !== raw) await writeFile(path, next)
  const s = parseSegment(id, await readFile(path, 'utf8'))
  return { ...s, body: withEntries(s.body, await readEntryFiles(gwDir, id)) }
}

export async function createSegment(gwDir: string, input: { name: string }): Promise<Segment> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!name) throw new Error('A segment needs a name')
  const taken = (await listSegments(gwDir)).find((s) => sameName(s.name, name))
  if (taken) throw new Error(`There is already a segment called ${taken.name}`)
  const dir = join(gwDir, 'segments')
  await mkdir(dir, { recursive: true })
  const id = newId('sg_')
  const text = `---\nid: ${id}\nname: ${scalar(name)}\ncreated: ${today()}\n---\n`
  const tmp = join(dir, `.${id}.md.tmp`)
  await writeFile(tmp, text, { flag: 'wx' })
  await rename(tmp, join(dir, `${id}.md`))
  return parseSegment(id, text)
}

/** Remove a segment and its thread. Personas keep the id in `segments:` until they are edited. */
export async function deleteSegment(gwDir: string, id: string): Promise<boolean> {
  if (!ID.test(id)) return false
  try {
    await unlink(join(gwDir, 'segments', `${id}.md`))
  } catch {
    return false
  }
  await removeEntries(gwDir, id)
  return true
}

function empty(id: string): Segment {
  return { id, name: id, type: '', industry: '', size_min: 0, size_max: 0, admins: [], source: '', created: '', body: '' }
}

function size(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s_+]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function text(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : []
}
