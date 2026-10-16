import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { readOutput } from '../src/store/stories.js'
import { readReadiness } from '../src/store/readiness.js'
import { appendEntry } from '../src/shared/thread.js'

// A pull request can add symbolic links to .grndwrk. grndwrk never follows them.
let root: string, gw: string, outside: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-links-'))
  gw = join(root, '.grndwrk')
  outside = join(root, 'outside')
  await mkdir(gw)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'SECRET\n')
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('links inside .grndwrk', () => {
  it('never writes a thread entry through a linked thread folder', async () => {
    const store = new NodeStore(gw)
    const n = (await store.create({ title: 'Booking', body: '## Thread\n\n**Claude asks** · 2026-10-13\nWhich day?\n' })).upserted[0]
    await mkdir(join(gw, 'threads'), { recursive: true })
    await symlink(outside, join(gw, 'threads', n.id))
    await expect(store.update(n.id, { body: appendEntry(n.body, 'you', 'Today', '2026-10-14') })).rejects.toThrow(/symbolic link/)
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  it('never writes through a linked threads folder, nor deletes in it', async () => {
    const store = new NodeStore(gw)
    const n = (await store.create({ title: 'Booking' })).upserted[0]
    await mkdir(join(outside, n.id))
    await writeFile(join(outside, n.id, 'keep.md'), 'keep')
    await symlink(outside, join(gw, 'threads'))
    await expect(store.delete(n.id)).rejects.toThrow(/symbolic link/)
    expect(await readFile(join(outside, n.id, 'keep.md'), 'utf8')).toBe('keep')
  })

  it('does not show a linked brief, report or gap', async () => {
    await mkdir(join(gw, 'outputs', 'brief'), { recursive: true })
    await symlink(join(outside, 'secret.txt'), join(gw, 'outputs', 'brief', '1800000000000-zz.md'))
    expect(await readOutput(gw, 'brief.md')).toBeNull()
    await mkdir(join(gw, 'readiness', 'gaps'), { recursive: true })
    await writeFile(join(outside, 'gap.json'), JSON.stringify({ id: 'gap_x', area: 'design', title: 'From outside', why: '', near: [], severity: 'nice' }))
    await symlink(join(outside, 'gap.json'), join(gw, 'readiness', 'gaps', 'gap_x.json'))
    expect((await readReadiness(gw)).gaps.map((g) => g.title)).not.toContain('From outside')
  })

  it('does not read cards through a linked nodes folder, or a linked .grndwrk', async () => {
    await mkdir(join(outside, 'nodes'))
    await writeFile(join(outside, 'nodes', 'n_aaaaaa.md'), '---\nid: n_aaaaaa\ntitle: From outside\n---\n')
    await symlink(join(outside, 'nodes'), join(gw, 'nodes'))
    expect((await new NodeStore(gw).list()).map((n) => n.title)).not.toContain('From outside')
    const linked = join(root, 'other', '.grndwrk')
    await mkdir(join(root, 'other'))
    await symlink(outside, linked)
    expect((await new NodeStore(linked).list()).map((n) => n.title)).not.toContain('From outside')
  })

  it('shows a linked card as unreadable, with why, instead of hiding it', async () => {
    await mkdir(join(gw, 'nodes'))
    await symlink(join(outside, 'secret.txt'), join(gw, 'nodes', 'n_bbbbbb.md'))
    const listed = await new NodeStore(gw).list()
    expect(listed.find((n) => n.id === 'n_bbbbbb')?.error).toMatch(/symbolic link/)
    expect(JSON.stringify(listed)).not.toContain('SECRET')
  })

  it('never lets init write through a linked command file in .claude', async () => {
    const { init } = await import('../src/init.js')
    const project = join(root, 'project')
    await mkdir(join(project, '.claude', 'commands'), { recursive: true })
    await symlink(join(outside, 'secret.txt'), join(project, '.claude', 'commands', 'brief.md'))
    const log = console.log
    console.log = () => {}
    try {
      await expect(init(project, { ask: async () => 'n' })).rejects.toThrow(/symbolic link/)
    } finally {
      console.log = log
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('SECRET\n')
    await expect(readFile(join(project, '.grndwrk', 'backup', 'commands', 'brief.md'), 'utf8')).rejects.toThrow()
  })
})
