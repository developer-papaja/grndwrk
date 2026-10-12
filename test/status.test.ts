import { describe, expect, it } from 'vitest'
import { buildStatus, partStatus } from '../src/shared/status.js'
import { parseFoundations } from '../src/store/readiness.js'
import type { Screen, Story } from '../src/shared/types.js'

const screen = (id: string, status: Screen['status'], extra: Partial<Screen> = {}): Screen => ({
  id, title: id, parent: '', purpose: '', audience: [], tasks: [], leads_to: [], code: [], stories: [], status, source: '', created: '', body: '', ...extra,
})
const story = (id: string, status: Story['status']) => ({ id, status, applies_to: [] }) as unknown as Story

describe('foundations.json', () => {
  it('keeps the standard order and group, reads a bad status as missing, and drops what it cannot use', () => {
    const f = parseFoundations(JSON.stringify([
      { id: 'design_tokens', status: 'partly', missing: ['No spacing scale', 7], suggestion: 'Add spacing tokens', draft: 'design_tokens.md' },
      { id: 'claude_md', status: 'great', group: 'whatever' },
      { id: 'tests', title: 'Tests for the core flows', group: 'Quality', status: 'done' },
      { id: 'Bad Id', title: 'x', status: 'done' },
      { id: 'claude_md', status: 'done' },
      { id: 'mystery', status: 'done' },
      { id: 'readme', status: 'done', draft: '../../etc/passwd' },
    ]))
    expect(f.map((x) => [x.id, x.group, x.status])).toEqual([
      ['claude_md', 'building with claude', 'missing'],
      ['readme', 'documentation', 'done'],
      ['design_tokens', 'design', 'partly'],
      ['tests', 'quality', 'done'],
    ])
    expect(f[2]).toMatchObject({ missing: ['No spacing scale'], suggestion: 'Add spacing tokens', draft: 'design_tokens.md' })
    expect(f[1].draft).toBeUndefined()
  })
})

describe('status', () => {
  it('says a part is done when built and every story on it is done', () => {
    expect(partStatus(screen('p_a', 'built', { stories: ['s_1', 's_2'] }), [story('s_1', 'done'), story('s_2', 'partial')]).status).toBe('partly')
    expect(partStatus(screen('p_a', 'built', { stories: ['s_1'] }), [story('s_1', 'done')]).status).toBe('done')
    expect(partStatus(screen('p_a', 'planned'), []).status).toBe('missing')
    expect(partStatus(screen('p_a', 'partial'), []).status).toBe('partly')
  })

  it('counts everything, lists what is left with missing first, and falls back on project.md for the purpose', () => {
    const s = buildStatus({
      foundations: parseFoundations(JSON.stringify([{ id: 'claude_md', status: 'partly' }, { id: 'readme', status: 'done' }, { id: 'design_philosophy', status: 'missing' }])),
      screens: [screen('p_a', 'built'), screen('p_b', 'planned', { parent: 'p_a' })],
      stories: [],
      purpose: 'Book desks',
      blocking: 0,
      questions: 0,
    })
    expect(s.groups.map((g) => g.key)).toEqual(['thinking', 'purpose', 'parts', 'building with claude', 'documentation', 'design'])
    expect(s.left.map((r) => r.key)).toEqual(['part:p_b', 'design_philosophy', 'purpose', 'claude_md'])
    expect(s.groups[2].rows.map((r) => r.depth)).toEqual([0, 1])
    expect(s.done).toBe(3)
    expect(s.unchecked).toBe(4)
    expect(s.total).toBe(11)
  })
})
