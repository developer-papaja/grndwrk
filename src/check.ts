import { join, relative } from 'node:path'
import { readdir, readFile } from './store/fs.js'
import { readMatter } from './store/matter.js'

/**
 * `grndwrk check`: reads every file in `.grndwrk/` the way the map does and
 * says what does not read, what only reads because the map is lenient, and
 * two slips that hide questions without any error. Read only. Agents run it
 * after writing map files, so a broken header is fixed while it is fresh,
 * instead of showing up later as a card with only its id.
 */
export interface Finding {
  file: string
  kind: 'error' | 'fix' | 'question'
  message: string
}

const MATTER_DIRS = ['nodes', 'stories', 'screens', 'personas', 'segments']
const ENTRY_FILE = /^\d{9,13}-[a-z0-9]{2}\.md$/

export async function checkMap(gwDir: string): Promise<Finding[]> {
  const findings: Finding[] = []
  const rel = (path: string) => relative(gwDir, path).split('\\').join('/')
  const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()

  const read = async (path: string) => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      findings.push({ file: rel(path), kind: 'error', message: (err as Error).message })
      return undefined
    }
    try {
      const m = readMatter(raw)
      for (const fix of m.repaired ?? []) findings.push({ file: rel(path), kind: 'fix', message: `Reads only leniently. ${fix}.` })
      return m
    } catch (err) {
      findings.push({ file: rel(path), kind: 'error', message: `The header does not read. ${(err as Error).message}` })
      return undefined
    }
  }

  await read(join(gwDir, 'project.md')).catch(() => undefined)
  for (const dir of MATTER_DIRS) {
    for (const file of await list(join(gwDir, dir))) {
      if (!file.endsWith('.md')) continue
      const m = await read(join(gwDir, dir, file))
      if (dir === 'nodes' && m) {
        // A question written as a checkbox in the notes never shows as a question.
        const boxes = m.content.split('\n').filter((l) => /^\s*[-*] \[[ xX]\] .*\?\s*$/.test(l))
        if (boxes.length) findings.push({ file: rel(join(gwDir, dir, file)), kind: 'question', message: `${boxes.length} question${boxes.length > 1 ? 's' : ''} written as checkboxes in the notes, which the map does not show as questions. Write each as a claude-asks entry in threads/${file.slice(0, -3)}/.` })
      }
    }
  }

  for (const owner of await list(join(gwDir, 'threads'))) {
    let open = 0
    for (const file of (await list(join(gwDir, 'threads', owner))).filter((f) => ENTRY_FILE.test(f))) {
      const m = await read(join(gwDir, 'threads', owner, file))
      const who = String(m?.data.who ?? '').trim().toLowerCase()
      if (who === 'claude-asks') open++
      else if (who === 'you') open = 0
      else if (who === 'claude' && open) {
        findings.push({ file: rel(join(gwDir, 'threads', owner, file)), kind: 'question', message: `A plain claude entry right after ${open} open question${open > 1 ? 's' : ''} closes ${open > 1 ? 'them' : 'it'}. If ${open > 1 ? 'they are' : 'it is'} still open, make this entry claude-asks or put it in the question.` })
        open = 0
      }
    }
  }
  return findings
}

export function formatFindings(findings: Finding[]): string {
  if (!findings.length) return 'Every file in the map reads.'
  const label = { error: 'Does not read', fix: 'Fix', question: 'Hidden question' }
  // Messages quote the files, which can come from anyone through git: no control characters reach the terminal.
  const plain = (t: string) => t.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
  return findings.map((f) => `${label[f.kind]}: ${plain(f.file)}\n  ${plain(f.message)}`).join('\n')
}
