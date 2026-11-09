import { describe, expect, it } from 'vitest'
import { readMatter } from '../src/store/matter.js'
import { parseStory } from '../src/store/stories.js'
import { storyStatusLabel } from '../src/shared/story.js'

describe('headers agents get slightly wrong', () => {
  it('reads a bracket list whose items hold { } (a route with a parameter)', () => {
    const m = readMatter('---\ntitle: Book a visit\napplies_to: [/visits, /visits/{visit}/book, app/Visits]\n---\nBody\n')
    expect(m.data.applies_to).toEqual(['/visits', '/visits/{visit}/book', 'app/Visits'])
    expect(m.repaired?.[0]).toMatch(/applies_to: quote each item/)
  })

  it('leaves valid headers unmarked', () => {
    expect(readMatter('---\na: ["/x/{id}"]\n---\n').repaired).toBeUndefined()
  })

  it('says on which line of the file a header breaks', () => {
    expect(() => readMatter('---\ntitle: A\nfrom: [n_a\nb: "x\n---\n')).toThrow(/^Line \d+, column \d+: /)
  })

  it('does not count criteria on a story it cannot read', () => {
    const st = parseStory('s_abcdef', '---\ntitle: A\nfrom: [n_a\nstatus: "x\n---\n## Acceptance\n- [x] One\n')
    expect(st.error).toBeTruthy()
    expect(storyStatusLabel(st)).toBe("Can't be read")
  })
})

describe('grndwrk check', () => {
  it('lists headers that do not read, lists to quote and hidden questions', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { checkMap } = await import('../src/check.js')
    const gw = await mkdtemp(join(tmpdir(), 'gw-check-'))
    try {
      for (const d of ['nodes', 'stories', 'threads/n_aaaaaa']) await mkdir(join(gw, d), { recursive: true })
      await writeFile(join(gw, 'project.md'), '---\nname: Clinic\n---\n')
      await writeFile(join(gw, 'stories/s_aaaaaa.md'), '---\ntitle: A\nfrom: [n_aaaaaa]\napplies_to: [/visits/{visit}]\n---\n')
      await writeFile(join(gw, 'stories/s_bbbbbb.md'), '---\ntitle: "B\n---\n')
      await writeFile(join(gw, 'nodes/n_aaaaaa.md'), '---\nid: n_aaaaaa\ntitle: Visits\n---\nQuestions:\n- [ ] Who books the visit?\n')
      await writeFile(join(gw, 'threads/n_aaaaaa/1794000000000-aa.md'), '---\nwho: claude-asks\ndate: 2026-11-09\n---\nWho?\n')
      await writeFile(join(gw, 'threads/n_aaaaaa/1794000000001-ab.md'), '---\nwho: claude\ndate: 2026-11-09\n---\nA note.\n')
      const f = await checkMap(gw)
      expect(f.map((x) => `${x.kind} ${x.file}`)).toEqual([
        'question nodes/n_aaaaaa.md',
        'fix stories/s_aaaaaa.md',
        'error stories/s_bbbbbb.md',
        'question threads/n_aaaaaa/1794000000001-ab.md',
      ])
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })
})
