import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { SCREEN_STATUSES, type Screen } from '../shared/types.js'
import { oneOf, scalar } from './frontmatter.js'

const ID = /^p_[A-Za-z0-9_-]{1,60}$/
export const isScreenId = (id: string) => ID.test(id)

/** Read every screen. A broken file shows up with an error instead of hiding. */
export async function listScreens(gwDir: string): Promise<Screen[]> {
  const dir = join(gwDir, 'screens')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const screens: Screen[] = []
  for (const file of files) {
    const id = file.slice(0, -3)
    if (!ID.test(id)) continue
    try {
      screens.push(parseScreen(id, await readFile(join(dir, file), 'utf8')))
    } catch {
      // Deleted while reading.
    }
  }
  return screens
}

const KNOWN = ['id', 'title', 'parent', 'purpose', 'for', 'does', 'leads_to', 'code', 'stories', 'status', 'source', 'created']

export function parseScreen(id: string, raw: string): Screen {
  let data: Record<string, unknown>
  let body: string
  try {
    const parsed = matter(raw, {})
    data = parsed.data
    body = parsed.content
  } catch (err) {
    return { ...empty(id), body: raw, error: (err as Error).message.split('\n')[0] }
  }
  return {
    id,
    title: text(data.title) || id,
    parent: text(data.parent),
    purpose: text(data.purpose),
    audience: list(data.for),
    tasks: list(data.does),
    leads_to: list(data.leads_to).filter((x) => ID.test(x) && x !== id),
    code: list(data.code),
    stories: list(data.stories),
    status: oneOf(data.status, SCREEN_STATUSES, 'built'),
    source: text(data.source),
    created: data.created instanceof Date ? data.created.toISOString().slice(0, 10) : text(data.created),
    body,
  }
}

function empty(id: string): Screen {
  return { id, title: id, parent: '', purpose: '', audience: [], tasks: [], leads_to: [], code: [], stories: [], status: 'built', source: '', created: '', body: '' }
}

function text(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** What the person can change from the map: the words, and the notes with the thread. */
export interface ScreenEdit {
  purpose?: string
  audience?: string[]
  tasks?: string[]
  body?: string
}

/**
 * Change a screen, keeping its other fields and any keys we do not know.
 * Lists that read as short phrases stay on one line, tasks one per line.
 */
export async function updateScreen(gwDir: string, id: string, edit: ScreenEdit): Promise<Screen | null> {
  if (!ID.test(id)) return null
  const path = join(gwDir, 'screens', `${id}.md`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { data, content } = matter(raw, {})
  const screen = parseScreen(id, raw)
  if (screen.error) throw new Error(`screens/${id}.md cannot be read: ${screen.error}`)
  const next = { ...screen, ...defined(edit) }
  const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !KNOWN.includes(k)))
  await writeFile(path, serializeScreen(next, extra, edit.body ?? content))
  return parseScreen(id, await readFile(path, 'utf8'))
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

export function serializeScreen(s: Screen, extra: Record<string, unknown>, body: string): string {
  // Inside [a, b] a comma or bracket would split an item, so such items are quoted.
  const inline = (xs: string[]) => `[${xs.map((x) => (/[,[\]{}]/.test(x) ? JSON.stringify(x) : scalar(x))).join(', ')}]`
  const lines = [
    `id: ${s.id}`,
    `title: ${scalar(s.title)}`,
    ...(s.parent ? [`parent: ${s.parent}`] : []),
    `purpose: ${scalar(s.purpose)}`,
    `for: ${inline(s.audience)}`,
    ...(s.tasks.length ? ['does:', ...s.tasks.map((t) => `  - ${scalar(t)}`)] : ['does: []']),
    `leads_to: ${inline(s.leads_to)}`,
    `code: ${inline(s.code)}`,
    `stories: ${inline(s.stories)}`,
    `status: ${s.status}`,
    ...(s.source ? [`source: ${s.source}`] : []),
    ...(s.created ? [`created: ${s.created}`] : []),
  ]
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${scalar(k)}: ${typeof v === 'string' ? scalar(v) : JSON.stringify(v instanceof Date ? v.toISOString().slice(0, 10) : v)}`)
  }
  return `---\n${lines.join('\n')}\n---\n${body}`
}
