import { describe, expect, it } from 'vitest'
import { buildBoard, buildOutline, firstLine } from '../ui/src/board.js'
import type { Gap, GNode, Story } from '../src/shared/types.js'

const node = (id: string, topic: string, altitude: number, modified?: string): GNode => ({
  id, type: 'idea', title: id, topic, page: '', altitude, links: [], status: 'open', created: '2026-10-01', body: '', extra: {}, ...(modified ? { modified } : {}),
}) as GNode
const gap = (id: string, topic: string, altitude: number, answered_by?: string): Gap => ({
  id, area: 'design', title: id, why: '', near: [], severity: 'blocking', topic, altitude, ...(answered_by ? { answered_by } : {}),
})

describe('board', () => {
  it('puts each card in its topic column and altitude row, newest first', () => {
    const b = buildBoard([node('a', 'Look', 4, '2026-10-01'), node('b', 'look', 4, '2026-10-05'), node('c', '', 1), node('d', 'Flows', 2)], [], [])
    expect(b.columns.map((c) => [c.key, c.count])).toEqual([['flows', 1], ['look', 2], ['', 1]])
    expect(b.rows.map((r) => r.altitude)).toEqual([5, 4, 3, 2, 1])
    expect(b.rows[1].cells[1].nodes.map((n) => n.id)).toEqual(['b', 'a'])
    expect(b.rows[4].cells[2].nodes.map((n) => n.id)).toEqual(['c'])
  })

  it('shows open gaps as ghosts, with a column of their own when no thought has that topic', () => {
    const b = buildBoard([node('a', 'Look', 3)], [gap('g1', 'Typography', 2), gap('g2', 'Look', 3, 'a')], [])
    expect(b.columns.map((c) => [c.key, c.missing])).toEqual([['look', 0], ['typography', 1]])
    expect(b.rows[3].cells[1].gaps.map((g) => g.id)).toEqual(['g1'])
  })

  it('puts a story under the column of its first source thought', () => {
    const story = { id: 's_1', title: 'S', status: 'not-started', from: ['b', 'a'], applies_to: [], created: '', body: '' } as Story
    const b = buildBoard([node('a', 'Look', 3), node('b', 'Flows', 3)], [], [story])
    expect(b.stories.map((l) => l.map((s) => s.id))).toEqual([['s_1'], []])
  })

  it('outlines topics with only the altitudes that hold something', () => {
    const o = buildOutline([node('a', 'Look', 5), node('b', 'Look', 2)], [])
    expect(o[0].levels.map((l) => l.word)).toEqual(['vision', 'feature'])
  })

  it('takes the first plain line of the notes, before the thread', () => {
    expect(firstLine('![shot](../files/x/a.png)\n\n## Why\nBecause [the doc](x.md) says so.\n\n## Thread\n**You** · 1')).toBe('Why')
    expect(firstLine('\n## Thread\n**Claude asks** · 2026')).toBe('')
  })
})
