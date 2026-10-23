import { describe, expect, it } from 'vitest'
import { buildBoard, buildOutline, firstLine, screenOf, sectionsOf } from '../ui/src/board.js'
import type { Gap, GNode, Screen, Story } from '../src/shared/types.js'

const node = (id: string, topic: string, altitude: number, extra: Record<string, unknown> = {}, modified?: string): GNode =>
  ({ id, type: 'idea', title: id, topic, page: '', altitude, links: [], status: 'open', created: '2026-10-01', body: '', extra, ...(modified ? { modified } : {}) }) as GNode
const gap = (id: string, topic: string, altitude: number, more: Partial<Gap> = {}): Gap => ({ id, area: 'design', title: id, why: '', near: [], severity: 'blocking', topic, altitude, ...more })
const screen = (id: string, title: string, parent = ''): Screen => ({
  id, title, parent, purpose: '', audience: [], tasks: [], leads_to: [], code: [], stories: [], features: [], status: 'built', source: '', created: '', body: '',
})
const ids = (col: { items: { id: string }[] }) => col.items.map((i) => i.id)

describe('board by topic', () => {
  it('has a column per topic, no topic last, cards from vision down, newest first within a level', () => {
    const b = buildBoard([node('a', 'Look', 4, {}, '2026-10-01'), node('b', 'look', 4, {}, '2026-10-05'), node('c', '', 1), node('d', 'Flows', 2), node('e', 'Look', 5)], [], [])
    expect(b.groupBy).toBe('topic')
    expect(b.columns.map((c) => [c.key, c.count])).toEqual([['flows', 1], ['look', 3], ['', 1]])
    expect(ids(b.columns[1])).toEqual(['e', 'b', 'a'])
  })

  it('shows open gaps as ghosts, with a column of their own when no thought has that topic', () => {
    const b = buildBoard([node('a', 'Look', 3)], [gap('g1', 'Typography', 2), gap('g2', 'Look', 3, { answered_by: 'a' })], [])
    expect(b.columns.map((c) => [c.key, c.missing])).toEqual([['look', 0], ['typography', 1]])
    expect(ids(b.columns[1])).toEqual(['gap:g1'])
  })
})

describe('board by screen', () => {
  const screens = [screen('p_home', 'Home'), screen('p_plan', 'Plan'), screen('p_goal', 'Goals', 'p_plan'), screen('p_set', 'Settings')]

  it('puts General first, then screens with something on them, in sitemap order, with where they sit', () => {
    const b = buildBoard([node('a', 'x', 5), node('b', 'x', 2, { screen: 'p_goal' }), node('c', 'x', 3, { screen: 'p_home' }), node('d', 'x', 3, { screen: 'p_gone' })], [gap('g', 'x', 2, { screen: 'p_goal' })], [], { groupBy: 'page', screens })
    expect(b.columns.map((c) => c.name)).toEqual(['General', 'Home', 'Goals'])
    expect(ids(b.columns[0])).toEqual(['a', 'd'])
    expect(ids(b.columns[2])).toEqual(['b', 'gap:g'])
    expect(b.columns[2].path).toBe('Plan')
  })

  it('files a comment from the running product under the screen it was made on', () => {
    expect(screenOf(node('c', 'Plan', 1, { source: 'app' }), screens)).toBe('p_plan')
    expect(screenOf(node('c', 'Plan', 1), screens)).toBe('')
  })

  it('falls back on topics when there is no sitemap', () => {
    expect(buildBoard([node('a', 'Look', 3)], [], [], { groupBy: 'page' }).groupBy).toBe('topic')
  })

  it('puts a story under the first screen that covers it', () => {
    const st = { id: 's_1', title: 'S', status: 'not-started', from: ['a'], applies_to: [], created: '', body: '' } as Story
    const withStory = [screen('p_home', 'Home'), { ...screen('p_plan', 'Plan'), stories: ['s_1'] }]
    const b = buildBoard([node('a', 'x', 3)], [], [st], { groupBy: 'page', screens: withStory })
    expect(b.columns.map((c) => [c.name, c.stories.map((s) => s.id)])).toEqual([['General', []], ['Plan', ['s_1']]])
  })
})

describe('outline', () => {
  it('reads each column from vision to detail, only the levels that hold something', () => {
    const o = buildOutline(buildBoard([node('a', 'Look', 5), node('b', 'Look', 2)], [], []))
    expect(o[0].levels.map((l) => l.word)).toEqual(['vision', 'feature'])
  })
})

describe('first line', () => {
  it('takes the first plain line of the notes, before the thread', () => {
    expect(firstLine('![shot](../files/x/a.png)\n\n## Why\nBecause [the doc](x.md) says so.\n\n## Thread\n**You** · 1')).toBe('Why')
    expect(firstLine('\n## Thread\n**Claude asks** · 2026')).toBe('')
  })
})

describe('cards grouped inside a column', () => {
  const book = { ...screen('p_book', 'Booking'), features: ['Pick a day', 'Confirm', 'Cancel'] } as Screen
  const nodes = [
    node('a', 'Look', 2, { screen: 'p_book', feature: 'pick a day' }),
    node('b', '', 1, { screen: 'p_book', feature: 'Confirm' }),
    node('c', 'Look', 1, { screen: 'p_book' }),
    node('d', '', 3, { screen: 'p_book', feature: 'Weekends' }),
  ]

  it('by feature: in the order the screen lists them, empty ones too, then others, then no feature', () => {
    const b = buildBoard(nodes, [gap('g', 'Look', 2, { screen: 'p_book' })], [], { groupBy: 'page', cardGroup: 'feature', screens: [book] })
    const col = b.columns.find((c) => c.key === 'p_book')!
    expect(col.screen).toBe('p_book')
    expect(col.sections.map((s) => [s.name, s.items.map((i) => i.id)])).toEqual([
      ['Pick a day', ['a']],
      ['Confirm', ['b']],
      ['Cancel', []],
      ['Weekends', ['d']],
      ['No feature', ['gap:g', 'c']],
    ])
  })

  it('by level: one section without a name, as before', () => {
    const b = buildBoard(nodes, [], [], { groupBy: 'page', screens: [book] })
    expect(b.cardGroup).toBe('level')
    expect(b.columns.find((c) => c.key === 'p_book')!.sections.map((s) => s.name)).toEqual([''])
  })

  it('by topic and by type, with the ones without last', () => {
    const items = nodes.map((n) => ({ kind: 'node' as const, id: n.id, node: n, altitude: n.altitude }))
    expect(sectionsOf(items, 'topic').map((s) => [s.name, s.items.length])).toEqual([['Look', 2], ['No topic', 2]])
    const typed = items.map((i, n) => ({ ...i, node: { ...i.node, type: (['question', 'idea', 'feature', 'idea'] as const)[n] } }))
    expect(sectionsOf(typed, 'type').map((s) => s.name)).toEqual(['idea', 'feature', 'question'])
  })

  it('reads the sections as the outline, when grouped', () => {
    const b = buildBoard(nodes, [], [], { groupBy: 'page', cardGroup: 'feature', screens: [book] })
    expect(buildOutline(b).find((s) => s.key === 'p_book')!.levels.map((l) => l.word)).toEqual(['Pick a day', 'Confirm', 'Weekends', 'No feature'])
  })
})
