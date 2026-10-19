import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asSkill, init } from '../src/init.js'
import { readMatter } from '../src/store/matter.js'
import { noMapMessage, PACKAGE_ROOT } from '../src/root.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-init-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const command = (name: string) => join(root, '.claude', 'commands', name)
const shipped = (name: string) => readFile(join(PACKAGE_ROOT, 'commands', name), 'utf8')

describe('init', () => {
  it('installs the commands as skills for Codex and Cursor, and the map rules as AGENTS.md and a skill', async () => {
    await init(root)
    const skill = readMatter(await readFile(join(root, '.agents', 'skills', 'readiness', 'SKILL.md'), 'utf8'))
    expect(skill.data.name).toBe('readiness')
    expect(skill.data.description).toMatch(/ready to build/)
    expect(skill.data['disable-model-invocation']).toBe(true)
    expect(skill.content).toBe(readMatter(await shipped('readiness.md')).content)
    const rules = await readFile(join(PACKAGE_ROOT, 'templates', 'CLAUDE.md'), 'utf8')
    expect(await readFile(join(root, '.grndwrk', 'AGENTS.md'), 'utf8')).toBe(rules)
    const map = readMatter(await readFile(join(root, '.agents', 'skills', 'grndwrk-map', 'SKILL.md'), 'utf8'))
    expect(map.data.name).toBe('grndwrk-map')
    expect(map.data['disable-model-invocation']).toBeUndefined()
  })

  it("never replaces someone's own skill of the same name", async () => {
    await mkdir(join(root, '.agents', 'skills', 'import'), { recursive: true })
    await writeFile(join(root, '.agents', 'skills', 'import', 'SKILL.md'), '---\nname: import\ndescription: Mine\n---\nMine.\n')
    await init(root)
    await init(root)
    expect(await readFile(join(root, '.agents', 'skills', 'import', 'SKILL.md'), 'utf8')).toContain('Mine.')
  })

  it('tells Codex users how to give it the map rules when the project has an AGENTS.md', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
    const log = vi.spyOn(console, 'log')
    await init(root)
    expect(log.mock.calls.flat().join('\n')).toContain('follow .grndwrk/AGENTS.md')
  })

  it('makes a skill whose description YAML reads back as written', () => {
    const skill = asSkill('x', '---\ndescription: Judge it: ready or not\n---\nBody\n', false)
    expect(readMatter(skill).data.description).toBe('Judge it: ready or not')
  })

  it('moves a map from before the rename, .groundwork/, to .grndwrk/', async () => {
    await mkdir(join(root, '.groundwork', 'nodes'), { recursive: true })
    await writeFile(join(root, '.groundwork', 'nodes', 'n_abc123.md'), '---\nid: n_abc123\ntitle: Kept\n---\n')
    expect(noMapMessage(root)).toContain('Run `grndwrk init` there to move it')
    await init(root)
    expect(existsSync(join(root, '.groundwork'))).toBe(false)
    expect(await readFile(join(root, '.grndwrk', 'nodes', 'n_abc123.md'), 'utf8')).toContain('title: Kept')
    expect(noMapMessage(join(root, 'sub'))).toContain('No .grndwrk/ folder')
  })

  it('moves nothing when the old folder holds a link, so the map is never left half set up', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'gw-elsewhere-'))
    try {
      await mkdir(join(root, '.groundwork'))
      await symlink(elsewhere, join(root, '.groundwork', 'nodes'))
      await init(root)
      expect(existsSync(join(root, '.groundwork', 'nodes'))).toBe(true)
      expect(existsSync(join(root, '.grndwrk'))).toBe(false)
      process.exitCode = 0
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('updates the map rules an init from before the rename installed', async () => {
    await mkdir(join(root, '.groundwork'), { recursive: true })
    const old = 'Rules for the Groundwork map in .groundwork/\n'
    await writeFile(join(root, '.groundwork', 'CLAUDE.md'), old)
    const sum = (await import('node:crypto')).createHash('sha256').update(old).digest('hex').slice(0, 16)
    await writeFile(join(root, '.groundwork', 'commands.json'), JSON.stringify({ '.groundwork/CLAUDE.md': sum }))
    await init(root)
    expect(await readFile(join(root, '.grndwrk', 'CLAUDE.md'), 'utf8')).toBe(await readFile(join(PACKAGE_ROOT, 'templates', 'CLAUDE.md'), 'utf8'))
    expect(Object.keys(JSON.parse(await readFile(join(root, '.grndwrk', 'commands.json'), 'utf8')))).not.toContain('.groundwork/CLAUDE.md')
  })

  it('never moves .groundwork/ when it is a link, or over a .grndwrk/ that is there', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'gw-elsewhere-'))
    try {
      await symlink(elsewhere, join(root, '.groundwork'))
      await init(root)
      expect(existsSync(join(root, '.grndwrk', 'project.md'))).toBe(true)
      expect(existsSync(join(elsewhere, 'project.md'))).toBe(false)
      // Both there now: nothing moves.
      await rm(join(root, '.groundwork'))
      await mkdir(join(root, '.groundwork'))
      await init(root)
      expect(existsSync(join(root, '.groundwork'))).toBe(true)
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('updates commands nobody changed and keeps the ones the person changed', async () => {
    await init(root)
    expect(await readFile(command('brief.md'), 'utf8')).toBe(await shipped('brief.md'))

    // An older grndwrk installed these; the person then edited brief.md.
    const manifest = JSON.parse(await readFile(join(root, '.grndwrk', 'commands.json'), 'utf8'))
    await writeFile(command('readiness.md'), 'old readiness\n')
    manifest['readiness.md'] = (await import('node:crypto')).createHash('sha256').update('old readiness\n').digest('hex').slice(0, 16)
    await writeFile(join(root, '.grndwrk', 'commands.json'), JSON.stringify(manifest))
    await writeFile(command('brief.md'), 'my own brief\n')

    await init(root)
    expect(await readFile(command('readiness.md'), 'utf8')).toBe(await shipped('readiness.md'))
    expect(await readFile(command('brief.md'), 'utf8')).toBe('my own brief\n')
  })

  it('gives Claude the map rules in .grndwrk/CLAUDE.md, and keeps them when the person changed them', async () => {
    const rules = join(root, '.grndwrk', 'CLAUDE.md')
    await init(root)
    const shippedRules = await readFile(join(PACKAGE_ROOT, 'templates', 'CLAUDE.md'), 'utf8')
    expect(await readFile(rules, 'utf8')).toBe(shippedRules)
    expect(shippedRules).toContain('built:')
    expect(await readFile(join(root, '.grndwrk', '.gitignore'), 'utf8')).toContain('local.json')
    await writeFile(rules, 'my own rules\n')
    await init(root)
    expect(await readFile(rules, 'utf8')).toBe('my own rules\n')
  })

  it('keeps a .grndwrk/CLAUDE.md written by hand before grndwrk shipped one', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.grndwrk'), { recursive: true })
    await writeFile(join(root, '.grndwrk', 'CLAUDE.md'), '# My own rules\n')
    await init(root)
    expect(await readFile(join(root, '.grndwrk', 'CLAUDE.md'), 'utf8')).toBe('# My own rules\n')
  })

  it('takes Scope out of a checklist that still has it as shipped, and keeps a reworded one', async () => {
    await init(root)
    const path = join(root, '.grndwrk', 'readiness', 'checklist.md')
    const scope = '**Scope.** What is in the first version and what is explicitly out.\nEnough when: there is at least one thing you decided not to build.\n\n'
    const before = await readFile(path, 'utf8')
    expect(before).not.toContain('**Scope.**')
    await writeFile(path, before.replace('**Content and tone.**', scope + '**Content and tone.**'))
    await init(root)
    expect(await readFile(path, 'utf8')).toBe(before)
    await writeFile(path, before + '\n**Scope.** Only what the client signed.\n')
    await init(root)
    expect(await readFile(path, 'utf8')).toContain('Only what the client signed')
  })

  it('backs up a command installed before init kept track, then updates it', async () => {
    await init(root)
    await rm(join(root, '.grndwrk', 'commands.json'))
    await writeFile(command('survey.md'), 'survey from last week\n')
    await init(root)
    expect(await readFile(command('survey.md'), 'utf8')).toBe(await shipped('survey.md'))
    expect(await readFile(join(root, '.grndwrk', 'backup', 'commands', 'survey.md'), 'utf8')).toBe('survey from last week\n')
  })

  it('never overwrites the map', async () => {
    await init(root)
    await writeFile(join(root, '.grndwrk', 'project.md'), '---\nname: Mine\nstart: new\n---\n')
    await init(root)
    expect(await readFile(join(root, '.grndwrk', 'project.md'), 'utf8')).toBe('---\nname: Mine\nstart: new\n---\n')
  })
})

describe('new or existing', () => {
  it('counts an empty folder as new and a folder with code as existing, without asking when there is no terminal', async () => {
    await init(root)
    expect(await readFile(join(root, '.grndwrk', 'project.md'), 'utf8')).toMatch(/^start: new$/m)

    const other = await mkdtemp(join(tmpdir(), 'gw-init-'))
    await writeFile(join(other, 'package.json'), '{}')
    await init(other)
    expect(await readFile(join(other, '.grndwrk', 'project.md'), 'utf8')).toMatch(/^start: existing$/m)
    await rm(other, { recursive: true, force: true })
  })

  it('asks, takes the answer, and never asks again', async () => {
    await writeFile(join(root, 'package.json'), '{}')
    const asked: string[] = []
    await init(root, { ask: async (q) => (asked.push(q), 'n') })
    expect(asked[0]).toMatch(/has code/)
    expect(await readFile(join(root, '.grndwrk', 'project.md'), 'utf8')).toMatch(/^start: new$/m)
    await init(root, { ask: async (q) => (asked.push(q), 'y') })
    expect(asked).toHaveLength(1)
  })

  it('adds start to a project.md written before it existed', async () => {
    await init(root)
    const path = join(root, '.grndwrk', 'project.md')
    await writeFile(path, '---\nname: Desks\npurpose: Book desks\n---\nNotes\n')
    await init(root, { ask: async () => 'n' })
    const text = await readFile(path, 'utf8')
    expect(text).toMatch(/^start: existing$/m)
    expect(text).toContain('purpose: Book desks')
    expect(text).toContain('Notes')
  })
})
