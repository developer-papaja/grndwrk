import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { docOnDisk, listDocs, readDoc } from '../src/server/docs.js'
import { parseFoundations } from '../src/store/readiness.js'

let root: string, gw: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-docs-'))
  gw = join(root, '.grndwrk')
  await mkdir(join(gw, 'outputs', 'drafts'), { recursive: true })
  await writeFile(join(root, 'CLAUDE.md'), '# Site\n\n## Code standards\nUse tabs.\n')
  await writeFile(join(root, 'README.md'), '# Readme\n')
  await mkdir(join(root, '.claude', 'commands'), { recursive: true })
  await writeFile(join(root, '.claude', 'commands', 'brief.md'), 'grndwrk command')
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'x', 'README.md'), 'not ours')
  await writeFile(join(gw, 'outputs', 'drafts', 'design_philosophy.md'), '# Design\nCalm.\n')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const foundations = () =>
  parseFoundations(JSON.stringify([
    { id: 'code_standards', status: 'partly', seen_in: ['CLAUDE.md#code-standards', 'package.json'], missing: ['No linter'], suggestion: 'Add Prettier' },
    { id: 'design_philosophy', status: 'missing', seen_in: [], missing: ['No design document'], suggestion: 'Write DESIGN.md', draft: 'design_philosophy.md', file: 'docs/DESIGN.md' },
    { id: 'readme', status: 'missing', seen_in: ['../../etc/passwd', '/etc/hosts'], missing: ['x'] },
  ]))

describe('the documents that steer Claude', () => {
  it("lists the project's own Markdown with what the check found, and suggests what is missing", async () => {
    const docs = await listDocs(gw, foundations())
    expect(docs.map((d) => [d.path, d.exists])).toEqual([['CLAUDE.md', true], ['README.md', true], ['docs/DESIGN.md', false]])
    expect(docs[0].findings).toEqual([{ id: 'code_standards', title: 'Code standards: linting and formatting', status: 'partly', missing: ['No linter'], suggestion: 'Add Prettier', section: 'code-standards' }])
    expect(docs[2].draft).toBe('design_philosophy.md')
    expect((await readDoc(gw, foundations(), 'docs/DESIGN.md')).draft).toBe('# Design\nCalm.\n')
  })

  it('never reads or opens anything outside the list: other paths, links, grndwrk commands', async () => {
    await symlink('/etc/hosts', join(root, 'HOSTS.md'))
    const docs = await listDocs(gw, foundations())
    expect(docs.map((d) => d.path)).not.toContain('HOSTS.md')
    for (const p of ['../outside.md', '/etc/hosts', '.claude/commands/brief.md', 'node_modules/x/README.md', 'HOSTS.md', '.grndwrk/project.md']) {
      await expect(readDoc(gw, foundations(), p)).rejects.toThrow()
      await expect(docOnDisk(gw, foundations(), p)).rejects.toThrow()
    }
    expect(await docOnDisk(gw, foundations(), 'CLAUDE.md')).toBe(join(root, 'CLAUDE.md'))
  })
  it('shows a link or a folder named as a document as unreadable, never as one to write', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'gw-outside-'))
    try {
      await writeFile(join(outside, 'target'), 'not to be overwritten')
      await mkdir(join(root, 'docs'), { recursive: true })
      await symlink(join(outside, 'target'), join(root, 'docs', 'DESIGN.md'))
      await mkdir(join(root, 'docs', 'folder.md'))
      const f = parseFoundations(JSON.stringify([
        { id: 'design_philosophy', status: 'missing', seen_in: ['docs/folder.md'], missing: ['x'], suggestion: '', draft: 'design_philosophy.md', file: 'docs/DESIGN.md' },
      ]))
      const docs = await listDocs(gw, f)
      const linked = docs.find((d) => d.path === 'docs/DESIGN.md')!
      expect(linked.blocked).toMatch(/symbolic link/)
      expect(linked.draft).toBeUndefined()
      expect(docs.find((d) => d.path === 'docs/folder.md')!.blocked).toMatch(/not a file/)
      await expect(readDoc(gw, f, 'docs/DESIGN.md')).rejects.toThrow(/symbolic link/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin')('leaves out grndwrk commands and dependencies whatever their letter case', async () => {
    const f = parseFoundations(JSON.stringify([
      { id: 'claude_tools', status: 'partly', seen_in: ['.Claude/Commands/brief.md', 'NODE_MODULES/x/README.md'], missing: ['x'], suggestion: '' },
    ]))
    const paths = (await listDocs(gw, f)).map((d) => d.path)
    expect(paths.some((p) => /commands|node_modules/i.test(p))).toBe(false)
  })

  it('reads only the first megabyte of a huge document', async () => {
    await writeFile(join(root, 'BIG.md'), 'a'.repeat(3_000_000))
    expect((await readDoc(gw, [], 'BIG.md')).text.length).toBe(1_000_000)
  })
})
