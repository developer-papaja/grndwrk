import { describe, expect, it } from 'vitest'
import { parseNode, scalar, serializeNode } from '../src/store/frontmatter.js'

const example = `---
id: n_8f2k
type: idea
title: Booking should feel like texting
altitude: 4
links: [n_2a9d, n_7c11]
status: open
created: 2026-10-02
---
Free text. Thoughts, references, half-formed questions.
`

describe('parseNode', () => {
  it('reads the example from CLAUDE.md', () => {
    const n = parseNode('n_8f2k', example)
    expect(n).toMatchObject({
      id: 'n_8f2k',
      type: 'idea',
      title: 'Booking should feel like texting',
      altitude: 4,
      links: ['n_2a9d', 'n_7c11'],
      status: 'open',
      created: '2026-10-02',
      body: 'Free text. Thoughts, references, half-formed questions.\n',
    })
    expect(n.error).toBeUndefined()
  })

  it('round trips byte for byte', () => {
    expect(serializeNode(parseNode('n_8f2k', example))).toBe(example)
  })

  it('fills defaults for a title only file', () => {
    const n = parseNode('n_aaaa', '---\ntitle: Just a thought\n---\n')
    expect(n).toMatchObject({ type: 'idea', altitude: 3, status: 'open', links: [], body: '' })
    expect(n.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('uses the filename as id and title when frontmatter is missing', () => {
    const n = parseNode('n_bbbb', 'Some text without frontmatter')
    expect(n.title).toBe('n_bbbb')
    expect(n.body).toBe('Some text without frontmatter')
  })

  it('clamps and replaces bad values instead of rejecting them', () => {
    const n = parseNode('n_cccc', '---\ntitle: x\naltitude: 9\ntype: Banana\nstatus: SETTLED\nlinks: n_dddd, n_cccc\n---\n')
    expect(n).toMatchObject({ altitude: 5, type: 'idea', status: 'settled', links: ['n_dddd'] })
  })

  it('reads topic and writes it right after the title, only when set', () => {
    const n = parseNode('n_tttt', '---\ntitle: x\naltitude: 2\ntopic: Look and feel\n---\n')
    expect(n.topic).toBe('Look and feel')
    expect(n.extra).toEqual({})
    expect(serializeNode(n)).toContain('title: x\ntopic: Look and feel\naltitude: 2\n')
    expect(serializeNode({ ...n, topic: '' })).not.toContain('topic:')
  })

  it('keeps unknown keys through a write', () => {
    const raw = '---\ntitle: x\nsource: interview\nweight: 2\n---\nbody\n'
    const out = serializeNode(parseNode('n_eeee', raw))
    expect(out).toContain('source: interview\n')
    expect(out).toContain('weight: 2\n')
    expect(parseNode('n_eeee', out).extra).toEqual({ source: 'interview', weight: 2 })
  })

  it('marks broken YAML as an error node and keeps the raw text', () => {
    const raw = '---\ntitle: a: b\n---\nmy notes\n'
    const n = parseNode('n_ffff', raw)
    expect(n.error).toBeTruthy()
    expect(n.body).toBe(raw)
  })
})

describe('scalar', () => {
  it('quotes only when needed and always round trips', () => {
    expect(scalar('Booking should feel like texting')).toBe('Booking should feel like texting')
    for (const s of ['Why: because', '? a question', '! decide', 'yes', '42', '2026-10-02', ' padded', '#tag', 'a #b', '"quoted"', "it's fine", 'ends with:']) {
      const n = parseNode('n_gggg', `---\ntitle: ${scalar(s)}\n---\n`)
      expect(n.error).toBeUndefined()
      expect(n.title).toBe(s.trim() || 'n_gggg')
    }
  })
})

describe('topic_by', () => {
  it('stays right after the topic', () => {
    const n = parseNode('n_tbtb', '---\ntitle: x\naltitude: 2\ntopic: nav\ncreated: 2026-10-03\ntopic_by: claude\n---\n')
    expect(serializeNode(n)).toContain('title: x\ntopic: nav\ntopic_by: claude\naltitude: 2\n')
  })
})
