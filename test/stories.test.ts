import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listStories, parseStory, readOutput } from '../src/store/stories.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
  await mkdir(join(root, 'stories'))
  await mkdir(join(root, 'outputs'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const example = `---
id: s_k3f9
title: Book a desk in three steps
status: not-started
from: [n_2a9d, n_7c11]
applies_to: []
created: 2026-10-02
---
As someone arriving at the office, I want to book a desk in three steps.

## Acceptance
- Booking takes at most three steps
`

describe('stories', () => {
  it('reads the story format from CLAUDE.md', () => {
    const s = parseStory('s_k3f9', example)
    expect(s).toMatchObject({ id: 's_k3f9', title: 'Book a desk in three steps', status: 'not-started', from: ['n_2a9d', 'n_7c11'], applies_to: [], created: '2026-10-02' })
    expect(s.error).toBeUndefined()
  })

  it('flags a story without from, and broken frontmatter, instead of hiding them', () => {
    expect(parseStory('s_a', '---\ntitle: X\n---\n').error).toMatch(/from/)
    expect(parseStory('s_b', '---\ntitle: a: b\n---\n').error).toBeTruthy()
  })

  it('lists only files with story ids', async () => {
    await writeFile(join(root, 'stories', 's_k3f9.md'), example)
    await writeFile(join(root, 'stories', 'notes.md'), 'not a story')
    expect((await listStories(root)).map((s) => s.id)).toEqual(['s_k3f9'])
  })

  it('serves only the two outputs /brief writes', async () => {
    await writeFile(join(root, 'outputs', 'brief.md'), '# Brief')
    expect(await readOutput(root, 'brief.md')).toBe('# Brief')
    expect(await readOutput(root, '../project.md')).toBeNull()
    expect(await readOutput(root, 'CLAUDE.starter.md')).toBeNull()
  })
})
