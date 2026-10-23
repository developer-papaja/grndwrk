import { readRun } from './runs.js'
import { mkdir, readdir, readFile, rename, writeFile } from './fs.js'
import { newId } from './nodes.js'
import { join } from 'node:path'
import { readMatter } from './matter.js'
import { scalar } from './frontmatter.js'
import { STORY_STATUSES, type Story, type StoryStatus } from '../shared/types.js'

const ID = /^s_[A-Za-z0-9_-]{1,60}$/

/** Read every story. A broken file shows up with an error instead of hiding. */
export async function listStories(gwDir: string): Promise<Story[]> {
  const dir = join(gwDir, 'stories')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const stories: Story[] = []
  for (const file of files) {
    const id = file.slice(0, -3)
    if (!ID.test(id)) continue
    try {
      stories.push(parseStory(id, await readFile(join(dir, file), 'utf8')))
    } catch {
      // Deleted while reading.
    }
  }
  return stories
}

export function parseStory(id: string, raw: string): Story {
  let data: Record<string, unknown>
  let body: string
  try {
    const parsed = readMatter(raw)
    data = parsed.data
    body = parsed.content
  } catch (err) {
    return { id, title: id, status: 'not-started', from: [], applies_to: [], created: '', body: raw, error: (err as Error).message.split('\n')[0] }
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()) : [])
  const status = String(data.status ?? '').trim().toLowerCase()
  const story: Story = {
    id,
    title: String(data.title ?? '').trim() || id,
    status: (STORY_STATUSES as readonly string[]).includes(status) ? (status as StoryStatus) : 'not-started',
    from: list(data.from),
    applies_to: list(data.applies_to),
    created: data.created instanceof Date ? data.created.toISOString().slice(0, 10) : String(data.created ?? ''),
    body,
    ...(typeof data.later === 'string' && data.later.trim() ? { later: data.later.trim() } : {}),
  }
  if (!story.from.length) story.error = 'This story names no thought it came from (from: is empty).'
  return story
}

export interface StoryEdit {
  title?: string
  status?: string
  body?: string
  /** A date sets it aside ("Not now"); null takes that back. */
  later?: string | null
}

/** Frontmatter values written by the map: plain, or quoted when YAML would read them otherwise (null, 1e3, a date). */
const yamlText = scalar

/**
 * A frontmatter field set, changed or removed in place, leaving every other
 * line as it was. A value written by hand over several lines (`title: |` or
 * `>` and indented lines after it) is replaced whole.
 */
export function setField(front: string, key: string, value: string | null): string {
  // A block value runs on over indented lines, and over blank lines between them.
  const block = `^${key}:.*(?:(?:\\n[ \\t]*)*\\n[ \\t]+\\S.*)*`
  const re = new RegExp(`${block}$`, 'm')
  if (value === null) return front.replace(new RegExp(`${block}\\n?`, 'm'), '')
  // A value on lines of its own (a map, indented under the key) starts with a newline.
  const line = `${key}:${value.startsWith('\n') ? '' : ' '}${value}`
  return re.test(front) ? front.replace(re, () => line) : `${front.replace(/\n?$/, '\n')}${line}\n`
}

/**
 * Change a story from the map: its title, status, text, or set it aside.
 * Only the lines that change are touched, so a story edited by two people on
 * their own branches still merges in git.
 */
export async function updateStory(gwDir: string, id: string, edit: StoryEdit): Promise<Story | null> {
  if (!ID.test(id)) return null
  const path = join(gwDir, 'stories', `${id}.md`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const story = parseStory(id, raw)
  if (story.error && !story.error.startsWith('This story names no thought')) throw new Error(`stories/${id}.md cannot be read: ${story.error}`)
  const m = /^---[^\n]*\n([\s\S]*?)\n---[^\n]*\n?/.exec(raw)
  if (!m) throw new Error(`stories/${id}.md has no frontmatter`)
  let front = m[1] + '\n'
  if (edit.title !== undefined && edit.title.trim() && edit.title.trim() !== story.title) front = setField(front, 'title', yamlText(edit.title.trim().slice(0, 200)))
  if (edit.status !== undefined && edit.status !== story.status) {
    if (!(STORY_STATUSES as readonly string[]).includes(edit.status)) throw new Error(`A story is not-started, partial or done, not ${edit.status}`)
    front = setField(front, 'status', edit.status)
  }
  if (edit.later !== undefined && (edit.later ?? undefined) !== story.later) front = setField(front, 'later', edit.later && /^\d{4}-\d{2}-\d{2}$/.test(edit.later) ? edit.later : null)
  const body = edit.body !== undefined ? edit.body : raw.slice(m[0].length)
  const next = `---\n${front.replace(/\n$/, '')}\n---\n${body}`
  if (next !== raw) await writeFile(path, next)
  return parseStory(id, await readFile(path, 'utf8'))
}

/** A new story from the map, written from a thought: the thought is where it came from. */
export async function createStory(gwDir: string, input: { title: string; from: string[]; body?: string }): Promise<Story> {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new Error('A story needs a title')
  const from = input.from.filter((x) => /^n_[A-Za-z0-9_-]{1,60}$/.test(x))
  if (!from.length) throw new Error('A story comes from at least one thought')
  const dir = join(gwDir, 'stories')
  await mkdir(dir, { recursive: true })
  const id = newId('s_')
  const day = new Date().toISOString().slice(0, 10)
  const body = input.body ?? 'As someone using the product, I want ..., so that ....\n\n## Acceptance\n- [ ] \n'
  const text = `---\nid: ${id}\ntitle: ${yamlText(title)}\nstatus: not-started\nfrom: [${from.join(', ')}]\napplies_to: []\ncreated: ${day}\n---\n${body}`
  const tmp = join(dir, `.${id}.md.tmp`)
  await writeFile(tmp, text, { flag: 'wx' })
  await rename(tmp, join(dir, `${id}.md`))
  return parseStory(id, text)
}

/** The outputs /brief and /survey write. Nothing else in outputs/ is served. */
export const OUTPUTS = ['brief.md', 'CLAUDE.starter.md', 'survey.md', 'personas.md'] as const

/** Where each output's runs are kept, one file per run. */
const RUNS: Record<(typeof OUTPUTS)[number], string> = { 'brief.md': 'brief', 'CLAUDE.starter.md': 'claude-starter', 'survey.md': 'survey', 'personas.md': 'personas' }

/** The newest run of an output, or the single file of an older map. */
export async function readOutput(gwDir: string, name: string): Promise<string | null> {
  if (!(OUTPUTS as readonly string[]).includes(name)) return null
  const folder = RUNS[name as (typeof OUTPUTS)[number]]
  return readRun(join(gwDir, 'outputs', folder), join(gwDir, 'outputs', name))
}

/** A draft /readiness wrote for something the project lacks, from outputs/drafts/. Only plain .md names. */
export async function readDraft(gwDir: string, name: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}\.md$/.test(name) || name.includes('..')) return null
  try {
    return await readFile(join(gwDir, 'outputs', 'drafts', name), 'utf8')
  } catch {
    return null
  }
}
