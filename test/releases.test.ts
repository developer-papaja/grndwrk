import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listReleases } from '../src/store/releases.js'
import { readRelease, releaseLabel, releasesOf } from '../src/shared/releases.js'

let gw: string
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-releases-'))
  await mkdir(join(gw, 'releases'))
})
afterEach(async () => {
  await rm(gw, { recursive: true, force: true })
})

const write = (id: string, text: string) => writeFile(join(gw, 'releases', `${id}.md`), text)

describe('releases', () => {
  it('reads each release file, newest first', async () => {
    await write('r_aaaaaa', '---\nname: "0.4.9"\ndate: 2026-11-10\nshipped: [s_k3f9ab]\n---\nThe calendar.\n')
    await write('r_bbbbbb', '---\nname: "0.4.10"\ndate: 2026-11-10\nwhere: npm\nshipped: [s_k3f9ab, n_q8r7st]\n---\n')
    await write('r_cccccc', '---\nname: Sprint 12\ndate: 2026-11-18\nshipped: [n_q8r7st]\n---\n')
    const list = await listReleases(gw)
    expect(list.map((r) => r.name)).toEqual(['Sprint 12', '0.4.10', '0.4.9'])
    expect(list[1]).toMatchObject({ where: 'npm', shipped: ['s_k3f9ab', 'n_q8r7st'] })
    expect(list[2].notes).toBe('The calendar.')
    expect(releasesOf('s_k3f9ab', list).map(releaseLabel)).toEqual(['0.4.9 · 2026-11-10', '0.4.10 · 2026-11-10'])
    expect(releasesOf('n_none00', list)).toEqual([])
  })

  it('shows a file that does not read, and leaves out other files', async () => {
    await write('r_broken', '---\nname: [unclosed\n---\n')
    await writeFile(join(gw, 'releases', 'notes.md'), '---\nname: x\n---\n')
    const list = await listReleases(gw)
    expect(list.map((r) => r.id)).toEqual(['r_broken'])
    expect(list[0].error).toMatch(/Can't be read/)
  })

  it('keeps only ids and plain words', () => {
    const r = readRelease('r_aaaaaa', { name: '0.5\u0007 beta', date: 'soon', shipped: ['s_k3f9ab', 'rm -rf', 7, 's_k3f9ab'], where: 'App\nStore' }, '')
    expect(r).toMatchObject({ name: '0.5 beta', date: '', where: 'App Store', shipped: ['s_k3f9ab'] })
    expect(readRelease('r_aaaaaa', {}, '').name).toBe('r_aaaaaa')
  })

  it('is missing without a releases folder', async () => {
    await rm(join(gw, 'releases'), { recursive: true })
    expect(await listReleases(gw)).toEqual([])
  })
})
