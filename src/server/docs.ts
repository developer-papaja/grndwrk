import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { BadInput } from '../store/nodes.js'
import { readDraft } from '../store/stories.js'
import type { Foundation } from '../shared/types.js'

/**
 * The documents that steer Claude in the product: CLAUDE.md, the README, the
 * Markdown in the project's root and docs/, skills, and every Markdown file a
 * check named, plus the ones a check suggests writing (from a draft). Shown in
 * the map, read only, with what the last check found in each and an
 * instruction to copy for Claude. Groundwork does not write them: only
 * Markdown files in this list, inside the project's own folder, never
 * through a symbolic link, are read or opened in the person's editor.
 */
export interface DocFinding {
  id: string
  title: string
  status: string
  missing: string[]
  suggestion: string
  /** The heading the finding is about, as the part after # in seen_in. */
  section?: string
}

export interface Doc {
  path: string
  exists: boolean
  findings: DocFinding[]
  /** A draft /readiness wrote for a document that is not there yet. */
  draft?: string
}

const SKIP = new Set(['node_modules', '.git', 'vendor', '.groundwork', 'dist', 'build', '.next', '.nuxt', 'storage', 'public'])

const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p)

/** Markdown files in a folder, a level or two down, skipping what is not the project's own. */
async function markdownIn(root: string, dir: string, depth: number): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name
    if (e.isSymbolicLink()) continue
    if (e.isFile() && isMarkdown(e.name)) out.push(rel)
    else if (e.isDirectory() && depth > 0 && !SKIP.has(e.name) && !e.name.startsWith('.')) out.push(...(await markdownIn(root, rel, depth - 1)))
  }
  return out
}

async function skills(root: string): Promise<string[]> {
  const out: string[] = []
  for (const base of ['.claude/skills']) {
    let names: string[] = []
    try {
      names = await readdir(join(root, base))
    } catch {
      continue
    }
    for (const n of names) {
      const p = `${base}/${n}/SKILL.md`
      if (await isPlainFile(root, p)) out.push(p)
    }
  }
  return out
}

/** A real file at this path inside the project, reached without a symbolic link anywhere on the way. */
async function isPlainFile(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    try {
      const st = await lstat(join(root, ...parts.slice(0, i)))
      if (st.isSymbolicLink()) return false
      if (i === parts.length) return st.isFile()
    } catch {
      return false
    }
  }
  return false
}

/** A path from a file or a check, as a clean path inside the project, or null. */
function clean(root: string, p: string): string | null {
  const bare = p.split('#')[0].trim().replace(/^\.\//, '')
  if (!bare || bare.includes('\0')) return null
  const full = resolve(root, bare)
  if (full !== root && !full.startsWith(root + sep)) return null
  const rel = relative(root, full).split(sep).join('/')
  if (!rel || rel.startsWith('..') || rel.split('/').some((s) => SKIP.has(s))) return null
  if (rel.startsWith('.claude/commands/')) return null // Groundwork's own commands, updated by init.
  return isMarkdown(rel) ? rel : null
}

export async function listDocs(gwDir: string, foundations: Foundation[]): Promise<Doc[]> {
  const root = resolve(dirname(gwDir))
  const found = new Map<string, Doc>()
  const add = (path: string, exists: boolean) => {
    if (!found.has(path)) found.set(path, { path, exists, findings: [] })
    return found.get(path)!
  }
  for (const p of [...(await markdownIn(root, '', 0)), ...(await markdownIn(root, 'docs', 2)), ...(await skills(root))]) add(p, true)
  for (const f of foundations) {
    for (const seen of f.seen_in ?? []) {
      const path = clean(root, seen)
      if (!path) continue
      const doc = add(path, await isPlainFile(root, path))
      const section = seen.includes('#') ? seen.split('#')[1] : undefined
      doc.findings.push({ id: f.id, title: f.title, status: f.status, missing: f.missing ?? [], suggestion: f.suggestion ?? '', ...(section ? { section } : {}) })
    }
    // A missing document with a draft: shown, to be written from it.
    if (f.draft && f.status !== 'done') {
      const path = clean(root, f.file ?? (f.draft.toLowerCase() === 'readme.md' ? 'README.md' : f.draft))
      if (path) {
        const doc = add(path, await isPlainFile(root, path))
        doc.draft = f.draft
        if (!doc.findings.some((x) => x.id === f.id)) doc.findings.push({ id: f.id, title: f.title, status: f.status, missing: f.missing ?? [], suggestion: f.suggestion ?? '' })
      }
    }
  }
  const order = (p: string) => (/^claude\.md$/i.test(p) ? 0 : /^readme\.md$/i.test(p) ? 1 : !p.includes('/') ? 2 : p.startsWith('.claude/') ? 4 : 3)
  return [...found.values()].sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path))
}

/** One document's text and version, only when it is in the list. */
export async function readDoc(gwDir: string, foundations: Foundation[], path: string): Promise<{ path: string; text: string; exists: boolean; draft?: string }> {
  const doc = (await listDocs(gwDir, foundations)).find((d) => d.path === path)
  if (!doc) throw new BadInput('Not a document Groundwork shows')
  const root = resolve(dirname(gwDir))
  if (!doc.exists) {
    const draft = doc.draft ? await readDraft(gwDir, doc.draft) : null
    return { path, text: '', exists: false, ...(draft ? { draft } : {}) }
  }
  if (!(await isPlainFile(root, path))) throw new BadInput(`${path} is a symbolic link or not a file`)
  const text = await readFile(join(root, path), 'utf8')
  return { path, text: text.length > 1_000_000 ? text.slice(0, 1_000_000) : text, exists: true }
}

/** The file on disk for a document in the list that exists, to open in the person's editor. */
export async function docOnDisk(gwDir: string, foundations: Foundation[], path: string): Promise<string> {
  const doc = (await listDocs(gwDir, foundations)).find((d) => d.path === path)
  if (!doc || !doc.exists) throw new BadInput('Not a document Groundwork shows')
  const root = resolve(dirname(gwDir))
  if (!(await isPlainFile(root, path))) throw new BadInput(`${path} is a symbolic link or not a file`)
  return join(root, path)
}
