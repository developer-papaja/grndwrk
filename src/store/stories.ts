import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
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
    const parsed = matter(raw, {})
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
  }
  if (!story.from.length) story.error = 'This story names no thought it came from (from: is empty).'
  return story
}

/** The two outputs /brief writes. Nothing else in outputs/ is served. */
export const OUTPUTS = ['brief.md', 'CLAUDE.starter.md'] as const

export async function readOutput(gwDir: string, name: string): Promise<string | null> {
  if (!(OUTPUTS as readonly string[]).includes(name)) return null
  try {
    return await readFile(join(gwDir, 'outputs', name), 'utf8')
  } catch {
    return null
  }
}
