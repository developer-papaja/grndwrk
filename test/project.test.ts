import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergePages, readProject, writeFields, writeKickoff, writePages } from '../src/store/project.js'
import { parseNode, serializeNode } from '../src/store/frontmatter.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('pages', () => {
  it('keeps the saved order and adds pages used by nodes', () => {
    expect(mergePages(['Product', 'Feedback'], ['feedback', 'Stories', ''])).toEqual(['Product', 'Feedback', 'Stories'])
    expect(mergePages([], [])).toEqual(['Main'])
  })

  it('writes pages into project.md and keeps everything else', async () => {
    await writeFile(join(root, 'project.md'), '---\nname: grndwrk\npurpose: "Map ideas: fast"\ntype: developer tool\n---\nBody stays.\n')
    await writePages(root, ['Product', 'Feedback', 'product'])
    const raw = await readFile(join(root, 'project.md'), 'utf8')
    expect(raw).toBe('---\nname: grndwrk\npurpose: "Map ideas: fast"\ntype: developer tool\npages: [Product, Feedback]\n---\nBody stays.\n')
    expect((await readProject(root)).pages).toEqual(['Product', 'Feedback'])
  })

  it('reads and writes a node page right after the topic', () => {
    const n = parseNode('n_pppp', '---\ntitle: x\npage: Feedback\ntopic: nav\naltitude: 2\n---\n')
    expect(n.page).toBe('Feedback')
    expect(serializeNode(n)).toContain('title: x\ntopic: nav\npage: Feedback\naltitude: 2\n')
  })

  it('signs kickoff steps off and reopens them, keeping everything else', async () => {
    await writeFile(join(root, 'project.md'), '---\nname: grndwrk\npages: [Product]\n---\nBody stays.\n')
    await writeKickoff(root, { check: '2026-10-08', map: '2026-10-07' })
    let raw = await readFile(join(root, 'project.md'), 'utf8')
    expect(raw).toBe('---\nname: grndwrk\npages: [Product]\nkickoff: { map: 2026-10-07, check: 2026-10-08 }\n---\nBody stays.\n')
    expect((await readProject(root)).data.kickoff).toEqual({ map: '2026-10-07', check: '2026-10-08' })
    // Writing pages keeps the kickoff as it was.
    await writePages(root, ['Product', 'Feedback'])
    expect((await readProject(root)).data.kickoff).toEqual({ map: '2026-10-07', check: '2026-10-08' })
    await writeKickoff(root, { check: null, map: null })
    raw = await readFile(join(root, 'project.md'), 'utf8')
    expect(raw).toBe('---\nname: grndwrk\npages: [Product, Feedback]\n---\nBody stays.\n')
  })
})

describe('the badge', () => {
  it('writes name, letters and color, and an empty value takes the field out', async () => {
    await writeFile(join(root, 'project.md'), '---\nname: Shop\npurpose: Sell things\n---\nNotes\n')
    await writeFields(root, { name: 'Harbor Rooms', initials: 'AR', color: '#e11d48' })
    let text = await readFile(join(root, 'project.md'), 'utf8')
    expect(text).toContain('name: Harbor Rooms\npurpose: Sell things\ninitials: AR\ncolor: "#e11d48"\n')
    expect((await readProject(root)).data.color).toBe('#e11d48')
    await writeFields(root, { initials: '', color: '' })
    text = await readFile(join(root, 'project.md'), 'utf8')
    expect(text).toBe('---\nname: Harbor Rooms\npurpose: Sell things\n---\nNotes\n')
  })
})
