import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { scalar } from './frontmatter.js'
export { mergePages } from '../shared/pages.js'

export interface Project {
  data: Record<string, unknown>
  body: string
  /** Page names in the order the person chose. */
  pages: string[]
}

export async function readProject(gwDir: string): Promise<Project> {
  try {
    const { data, content } = matter(await readFile(join(gwDir, 'project.md'), 'utf8'), {})
    return { data, body: content, pages: toPages(data.pages) }
  } catch {
    return { data: {}, body: '', pages: [] }
  }
}

/** Write the page list into project.md, keeping every other line as it was. */
export async function writePages(gwDir: string, pages: string[]): Promise<void> {
  const path = join(gwDir, 'project.md')
  const { data, body } = await readProject(gwDir)
  const next = { ...data, pages: toPages(pages) }
  const lines = Object.entries(next).map(([k, v]) => {
    if (k === 'pages') return `pages: [${(v as string[]).map(scalar).join(', ')}]`
    if (v == null) return `${k}:`
    if (typeof v === 'string') return `${k}: ${scalar(v)}`
    return `${k}: ${JSON.stringify(v)}`
  })
  const tmp = join(gwDir, '.project.md.tmp')
  await writeFile(tmp, `---\n${lines.join('\n')}\n---\n${body}`, 'utf8')
  await rename(tmp, path)
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
