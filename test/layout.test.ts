import { describe, expect, it } from 'vitest'
import { altitudeY, ALTITUDE_STEP, COLUMN_SPACING, CROSS_TOPIC_PULL, linkStrength, topicColumns, wrapLabel } from '../ui/src/layout.js'
import { flatten, groupForList } from '../ui/src/list.js'
import type { GNode } from '../src/shared/types.js'

const node = (id: string, title: string, topic = '', altitude = 3, body = ''): GNode => ({
  id, title, topic, altitude, body, type: 'idea', links: [], status: 'open', created: '2026-10-02', extra: {},
})

describe('altitudeY', () => {
  it('puts 5 highest and 1 lowest, 3 at zero', () => {
    expect(altitudeY(5)).toBe(2 * ALTITUDE_STEP)
    expect(altitudeY(3)).toBe(0)
    expect(altitudeY(1)).toBe(-2 * ALTITUDE_STEP)
    expect(altitudeY(9)).toBe(altitudeY(5))
  })
})

describe('topicColumns', () => {
  it('orders topics by name, centers them, and puts no topic last', () => {
    const cols = topicColumns([{ topic: 'Purpose' }, { topic: '' }, { topic: 'navigation' }, { topic: 'look and feel' }])
    expect([...cols.values()].map((c) => c.name)).toEqual(['look and feel', 'navigation', 'Purpose', 'no topic'])
    const xs = [...cols.values()].map((c) => c.x)
    expect(xs[1] - xs[0]).toBe(COLUMN_SPACING)
    expect(xs.reduce((a, b) => a + b, 0)).toBe(0)
  })
  it('treats case and spaces as the same topic', () => {
    expect(topicColumns([{ topic: 'Navigation' }, { topic: ' navigation ' }]).size).toBe(1)
  })
})

describe('linkStrength', () => {
  it('pulls much less across topics', () => {
    expect(linkStrength(false, 1, 1)).toBe(CROSS_TOPIC_PULL)
    expect(linkStrength(true, 4, 2)).toBe(0.5)
  })
})

describe('groupForList', () => {
  const nodes = [
    node('a', 'Navigation should feel easy', 'navigation', 4),
    node('b', 'A list of the nodes', 'navigation', 2, 'search shows a list'),
    node('c', 'Better orbs', 'look and feel', 2),
    node('d', 'Loose thought'),
  ]
  it('groups by topic in column order, abstract first, with totals', () => {
    const g = groupForList(nodes, '')
    expect(g.map((x) => [x.name, x.total])).toEqual([['look and feel', 1], ['navigation', 2], ['no topic', 1]])
    expect(g[1].nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('filters by title, notes and topic, and keeps topic totals', () => {
    expect(flatten(groupForList(nodes, 'LIST')).map((n) => n.id)).toEqual(['b'])
    expect(groupForList(nodes, 'list')[0].total).toBe(2)
    expect(flatten(groupForList(nodes, 'feel')).map((n) => n.id).sort()).toEqual(['a', 'c'])
  })
})

describe('wrapLabel', () => {
  it('wraps to two lines and cuts the rest', () => {
    expect(wrapLabel('Short')).toBe('Short')
    expect(wrapLabel('Navigation should feel easy, not too deep.')).toBe('Navigation should feel\neasy, not too deep.')
    const long = wrapLabel('I think that most things that are clicked open like a panel or something')
    expect(long.split('\n')).toHaveLength(2)
    expect(long.endsWith('…')).toBe(true)
  })
})
