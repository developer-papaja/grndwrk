import { describe, expect, it } from 'vitest'
import { topicColumns } from '../ui/src/layout.js'
import { flatten, groupForList } from '../ui/src/list.js'
import type { GNode } from '../src/shared/types.js'

const node = (id: string, title: string, topic = '', altitude = 3, body = ''): GNode => ({
  id, title, topic, altitude, body, type: 'idea', links: [], status: 'open', created: '2026-10-02', extra: {},
})

describe('topicColumns', () => {
  it('orders topics by name and puts no topic last', () => {
    const cols = topicColumns([{ topic: 'Purpose' }, { topic: '' }, { topic: 'navigation' }, { topic: 'look and feel' }])
    expect([...cols.values()].map((c) => c.name)).toEqual(['look and feel', 'navigation', 'Purpose', 'no topic'])
  })
  it('treats case and spaces as the same topic', () => {
    expect(topicColumns([{ topic: 'Navigation' }, { topic: ' navigation ' }]).size).toBe(1)
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
