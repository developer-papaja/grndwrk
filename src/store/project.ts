import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { scalar } from './frontmatter.js'
export { mergePages } from '../shared/pages.js'

/**
 * The kickoff steps. Each is signed off by the person, with a date. A new
 * project goes through all of them; an existing one skips purpose, and shows
 * map, check and brief as Survey, Foundations and Plan.
 */
export const KICKOFF_STEPS = ['purpose', 'map', 'check', 'answer', 'brief', 'build'] as const
export type KickoffStep = (typeof KICKOFF_STEPS)[number]

export interface Project {
  data: Record<string, unknown>
  body: string
  /** Page names in the order the person chose. */
  pages: string[]
}

export async function readProject(gwDir: string): Promise<Project> {
  try {
    const { data, content } = matter(await readFile(join(gwDir, 'project.md'), 'utf8'), {})
    if (data.kickoff !== undefined) data.kickoff = toKickoff(data.kickoff)
    return { data, body: content, pages: toPages(data.pages) }
  } catch {
    return { data: {}, body: '', pages: [] }
  }
}

/** Write the page list into project.md, keeping every other line as it was. */
export async function writePages(gwDir: string, pages: string[]): Promise<void> {
  const { data, body } = await readProject(gwDir)
  await writeProject(gwDir, { ...data, pages: toPages(pages) }, body)
}

/**
 * Sign kickoff steps off (a date) or reopen them (null), keeping the rest.
 * Stored as `kickoff: { map: 2026-10-08, check: 2026-10-08 }`.
 */
export async function writeKickoff(gwDir: string, changes: Partial<Record<KickoffStep, string | null>>): Promise<void> {
  const { data, body } = await readProject(gwDir)
  const kickoff = toKickoff(data.kickoff)
  for (const [step, date] of Object.entries(changes)) {
    if (!(KICKOFF_STEPS as readonly string[]).includes(step)) continue
    if (date) kickoff[step as KickoffStep] = date
    else delete kickoff[step as KickoffStep]
  }
  const next: Record<string, unknown> = { ...data, kickoff }
  if (!Object.keys(kickoff).length) delete next.kickoff
  await writeProject(gwDir, next, body)
}

/** Set fields of project.md, such as `start: existing` or the purpose, keeping the rest. */
export async function writeFields(gwDir: string, fields: Record<string, string>): Promise<void> {
  const { data, body } = await readProject(gwDir)
  await writeProject(gwDir, { ...data, ...fields }, body)
}

async function writeProject(gwDir: string, next: Record<string, unknown>, body: string): Promise<void> {
  const path = join(gwDir, 'project.md')
  const lines = Object.entries(next).map(([k, v]) => {
    if (k === 'pages') return `pages: [${(v as string[]).map(scalar).join(', ')}]`
    if (k === 'kickoff') {
      const steps = KICKOFF_STEPS.filter((s) => (v as Record<string, string>)[s]).map((s) => `${s}: ${(v as Record<string, string>)[s]}`)
      return `kickoff: { ${steps.join(', ')} }`
    }
    if (v instanceof Date) return `${k}: ${v.toISOString().slice(0, 10)}`
    if (v == null) return `${k}:`
    if (typeof v === 'string') return `${k}: ${scalar(v)}`
    return `${k}: ${JSON.stringify(v)}`
  })
  const tmp = join(gwDir, '.project.md.tmp')
  await writeFile(tmp, `---\n${lines.join('\n')}\n---\n${body}`, 'utf8')
  await rename(tmp, path)
}

/** Signed off steps and their dates, whatever form the file has them in. */
function toKickoff(value: unknown): Partial<Record<KickoffStep, string>> {
  const out: Partial<Record<KickoffStep, string>> = {}
  if (!value || typeof value !== 'object') return out
  for (const step of KICKOFF_STEPS) {
    const v = (value as Record<string, unknown>)[step]
    if (v instanceof Date) out[step] = v.toISOString().slice(0, 10)
    else if (typeof v === 'string' && v.trim()) out[step] = v.trim()
    else if (v === true) out[step] = 'done'
  }
  return out
}

function toPages(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const v of list) {
    const p = String(v ?? '').trim()
    if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p)
  }
  return out
}
