import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseNode } from '../src/store/frontmatter.js'
import { parseScreen } from '../src/store/screens.js'
import { parseStory } from '../src/store/stories.js'
import { readProject } from '../src/store/project.js'
import { readMatter } from '../src/store/matter.js'

// A file in a pull request could start its frontmatter with ---js; gray-matter,
// which read these files before, ran it. It must never run, and must show as unreadable.
const ran = () => (globalThis as Record<string, unknown>).__groundworkRan
const payload = (lang: string) => `---${lang}\n(() => { globalThis.__groundworkRan = true; return { title: 'Looks normal' } })()\n---\nBody\n`

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__groundworkRan
})

describe('frontmatter is YAML only', () => {
  for (const lang of ['js', 'javascript', 'JS', 'coffee', 'cson', 'json']) {
    it(`refuses ---${lang} without running it`, () => {
      expect(() => readMatter(payload(lang))).toThrow(/only reads YAML/)
      expect(parseNode('n_abcd', payload(lang)).error).toBeTruthy()
      expect(parseScreen('p_abcd', payload(lang)).error).toBeTruthy()
      expect(parseStory('s_abcd', payload(lang)).error).toBeTruthy()
      expect(ran()).toBeUndefined()
    })
  }

  it('does not run it from project.md either', async () => {
    const gw = await mkdtemp(join(tmpdir(), 'gw-matter-'))
    try {
      await writeFile(join(gw, 'project.md'), payload('js'))
      expect((await readProject(gw)).data).toEqual({})
      expect(ran()).toBeUndefined()
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })

  it('still reads plain and ---yaml frontmatter', () => {
    expect(readMatter('---\ntitle: A\n---\nB').data).toEqual({ title: 'A' })
    expect(readMatter('---yaml\ntitle: A\n---\nB').data).toEqual({ title: 'A' })
  })
})

describe('reading like gray-matter did', () => {
  it('splits the same way and keeps dates as written', () => {
    expect(readMatter('No frontmatter here').data).toEqual({})
    expect(readMatter('----\nnot: frontmatter\n----\n').data).toEqual({})
    expect(readMatter('---\n# only a comment\n---\nText')).toEqual({ data: {}, content: 'Text' })
    expect(readMatter('---\ncreated: 2026-10-12\nlinks: [n_a, n_b]\n---\r\nBody\n')).toEqual({ data: { created: '2026-10-12', links: ['n_a', 'n_b'] }, content: 'Body\n' })
    expect(readMatter('---\ntitle: Open\n').data).toEqual({ title: 'Open' })
    expect(() => readMatter('---\npurpose: Check in: scan the code\n---\n')).toThrow()
  })

  it('reads no tags that make objects or run code', () => {
    expect(() => readMatter('---\nx: !!js/function "function () { return 1 }"\n---\n')).not.toThrow()
    expect(typeof readMatter('---\nx: !!js/function "function () { return 1 }"\n---\n').data.x).not.toBe('function')
  })
})
