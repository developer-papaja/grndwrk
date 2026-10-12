import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { init } from '../src/init.js'
import { PACKAGE_ROOT } from '../src/root.js'

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
  it('updates commands nobody changed and keeps the ones the person changed', async () => {
    await init(root)
    expect(await readFile(command('brief.md'), 'utf8')).toBe(await shipped('brief.md'))

    // An older Groundwork installed these; the person then edited brief.md.
    const manifest = JSON.parse(await readFile(join(root, '.groundwork', 'commands.json'), 'utf8'))
    await writeFile(command('readiness.md'), 'old readiness\n')
    manifest['readiness.md'] = (await import('node:crypto')).createHash('sha256').update('old readiness\n').digest('hex').slice(0, 16)
    await writeFile(join(root, '.groundwork', 'commands.json'), JSON.stringify(manifest))
    await writeFile(command('brief.md'), 'my own brief\n')

    await init(root)
    expect(await readFile(command('readiness.md'), 'utf8')).toBe(await shipped('readiness.md'))
    expect(await readFile(command('brief.md'), 'utf8')).toBe('my own brief\n')
  })

  it('backs up a command installed before init kept track, then updates it', async () => {
    await init(root)
    await rm(join(root, '.groundwork', 'commands.json'))
    await writeFile(command('survey.md'), 'survey from last week\n')
    await init(root)
    expect(await readFile(command('survey.md'), 'utf8')).toBe(await shipped('survey.md'))
    expect(await readFile(join(root, '.groundwork', 'backup', 'commands', 'survey.md'), 'utf8')).toBe('survey from last week\n')
  })

  it('never overwrites the map', async () => {
    await init(root)
    await writeFile(join(root, '.groundwork', 'project.md'), '---\nname: Mine\nstart: new\n---\n')
    await init(root)
    expect(await readFile(join(root, '.groundwork', 'project.md'), 'utf8')).toBe('---\nname: Mine\nstart: new\n---\n')
  })
})

describe('new or existing', () => {
  it('counts an empty folder as new and a folder with code as existing, without asking when there is no terminal', async () => {
    await init(root)
    expect(await readFile(join(root, '.groundwork', 'project.md'), 'utf8')).toMatch(/^start: new$/m)

    const other = await mkdtemp(join(tmpdir(), 'gw-init-'))
    await writeFile(join(other, 'package.json'), '{}')
    await init(other)
    expect(await readFile(join(other, '.groundwork', 'project.md'), 'utf8')).toMatch(/^start: existing$/m)
    await rm(other, { recursive: true, force: true })
  })

  it('asks, takes the answer, and never asks again', async () => {
    await writeFile(join(root, 'package.json'), '{}')
    const asked: string[] = []
    await init(root, { ask: async (q) => (asked.push(q), 'n') })
    expect(asked[0]).toMatch(/has code/)
    expect(await readFile(join(root, '.groundwork', 'project.md'), 'utf8')).toMatch(/^start: new$/m)
    await init(root, { ask: async (q) => (asked.push(q), 'y') })
    expect(asked).toHaveLength(1)
  })

  it('adds start to a project.md written before it existed', async () => {
    await init(root)
    const path = join(root, '.groundwork', 'project.md')
    await writeFile(path, '---\nname: Desks\npurpose: Book desks\n---\nNotes\n')
    await init(root, { ask: async () => 'n' })
    const text = await readFile(path, 'utf8')
    expect(text).toMatch(/^start: existing$/m)
    expect(text).toContain('purpose: Book desks')
    expect(text).toContain('Notes')
  })
})
