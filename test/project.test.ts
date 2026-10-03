import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergePages, readProject, writePages } from '../src/store/project.js'
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
    await writeFile(join(root, 'project.md'), '---\nname: Groundwork\npurpose: "Map ideas: fast"\ntype: developer tool\n---\nBody stays.\n')
    await writePages(root, ['Product', 'Feedback', 'product'])
    const raw = await readFile(join(root, 'project.md'), 'utf8')
    expect(raw).toBe('---\nname: Groundwork\npurpose: "Map ideas: fast"\ntype: developer tool\npages: [Product, Feedback]\n---\nBody stays.\n')
    expect((await readProject(root)).pages).toEqual(['Product', 'Feedback'])
  })

  it('reads and writes a node page right after the topic', () => {
    const n = parseNode('n_pppp', '---\ntitle: x\npage: Feedback\ntopic: nav\naltitude: 2\n---\n')
    expect(n.page).toBe('Feedback')
    expect(serializeNode(n)).toContain('title: x\ntopic: nav\npage: Feedback\naltitude: 2\n')
  })
})
