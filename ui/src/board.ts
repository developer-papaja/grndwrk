import { NODE_TYPES, type Gap, type GNode, type Screen, type Story } from '../../src/shared/types'
import { commentsForScreen, screenTree, storiesForScreen } from '../../src/shared/screens'
import { ALTITUDE_WORDS, topicColumns, topicKey } from './layout'

/** How the map draws its cards. The same files and the same meaning, drawn two ways. */
export type MapLayout = 'board' | 'outline'
export const MAP_LAYOUTS: { key: MapLayout; name: string; icon: string }[] = [
  { key: 'board', name: 'Board: a column per page or topic', icon: 'i-columns' },
  { key: 'outline', name: 'Outline: a section per page or topic, to read through', icon: 'i-outline' },
]

/** What the columns are: the product's pages from the sitemap, or topics. */
export type GroupBy = 'page' | 'topic'

/**
 * How the cards inside a column are grouped, like sub-groups in a Notion
 * board: by level (vision first, detail last, no headings), or into sections
 * by feature, topic or type, each still from vision to detail.
 */
export type CardGroup = 'level' | 'feature' | 'topic' | 'type'
export const CARD_GROUPS: { key: CardGroup; label: string; hint: string }[] = [
  { key: 'level', label: 'Level', hint: 'Vision first, detail last' },
  { key: 'feature', label: 'Feature', hint: 'The features of each screen' },
  { key: 'topic', label: 'Topic', hint: 'A section per topic' },
  { key: 'type', label: 'Type', hint: 'Ideas, questions, decisions...' },
]

/** A section of a column: the cards of one feature, topic or type. Empty key: none of them. */
export interface CardSection {
  key: string
  name: string
  items: BoardItem[]
}

/** A card in a column: a thought, or a ghost for something missing. */
export type BoardItem = { kind: 'node'; id: string; node: GNode; altitude: number } | { kind: 'gap'; id: string; gap: Gap; altitude: number }

export interface BoardColumn {
  /** The screen id or topic key. Empty for General, or for no topic. */
  key: string
  name: string
  /** Where a screen sits in the sitemap, like "Plan › Training plans". */
  path: string
  count: number
  /** Open gaps in this column. */
  missing: number
  /** From vision down to detail, newest first within a level. */
  items: BoardItem[]
  /** The items in sections, by the card grouping. With level, one section without a name. */
  sections: CardSection[]
  /** The screen the column is, when it is one: features are added to it. */
  screen: string
  stories: Story[]
}

export interface Board {
  groupBy: GroupBy
  cardGroup: CardGroup
  columns: BoardColumn[]
}

const fold = (s: string) => s.trim().toLowerCase()

/** A thought's feature, as written on it. */
export const featureOf = (n: GNode) => (typeof n.extra?.feature === 'string' ? n.extra.feature.trim() : '')

/**
 * A column's items in sections. Features come in the order their screen
 * lists them, empty ones too (so a card can be dropped in), then any other
 * feature a thought names; topics by name; types in their usual order. The
 * section without one comes last. Gaps go by their topic, and with no
 * feature or type.
 */
export function sectionsOf(items: BoardItem[], group: CardGroup, screen?: Screen): CardSection[] {
  if (group === 'level') return [{ key: '', name: '', items }]
  const valueOf = (it: BoardItem): string => {
    if (group === 'topic') return it.kind === 'node' ? it.node.topic.trim() : (it.gap.topic ?? '').trim()
    if (it.kind === 'gap') return ''
    return group === 'feature' ? featureOf(it.node) : it.node.type
  }
  const names = new Map<string, string>()
  if (group === 'feature') for (const f of screen?.features ?? []) if (!names.has(fold(f))) names.set(fold(f), f)
  for (const it of items) {
    const v = valueOf(it)
    if (v && !names.has(fold(v))) names.set(fold(v), v)
  }
  const order = [...names.keys()]
  const listed = group === 'feature' ? (screen?.features ?? []).length : 0
  const rest = order.slice(listed)
  if (group === 'type') rest.sort((a, b) => NODE_TYPES.indexOf(a as never) - NODE_TYPES.indexOf(b as never))
  else rest.sort((a, b) => a.localeCompare(b))
  const keys = [...order.slice(0, listed), ...rest]
  const sections = keys.map((k) => ({ key: k, name: names.get(k)!, items: items.filter((it) => fold(valueOf(it)) === k) }))
  const none = items.filter((it) => !valueOf(it))
  const noneName = { feature: 'No feature', topic: 'No topic', type: 'Missing' }[group]
  return none.length || !sections.length ? [...sections, { key: '', name: noneName, items: none }] : sections
}

const time = (n: GNode) => (n.modified ? Date.parse(n.modified) : Number.POSITIVE_INFINITY)
export const altitudeOf = (a: number | undefined) => Math.min(5, Math.max(1, Math.round(a ?? 3)))
/** Vision first, detail last; within a level, thoughts newest first, then the ghosts. */
const byLevel = (a: BoardItem, b: BoardItem) =>
  b.altitude - a.altitude ||
  (a.kind === b.kind ? (a.kind === 'node' && b.kind === 'node' ? time(b.node) - time(a.node) || a.node.title.localeCompare(b.node.title) : 0) : a.kind === 'node' ? -1 : 1)

/**
 * The screen a thought is about: its `screen:`, or for a comment made in the
 * running product, the screen it was made on. Empty means the whole product.
 */
export function screenOf(node: GNode, screens: Screen[]): string {
  const id = node.extra?.screen
  if (typeof id === 'string' && screens.some((s) => s.id === id)) return id
  if (node.extra?.source === 'app') return screens.find((s) => commentsForScreen(s, [node]).length)?.id ?? ''
  return ''
}

/**
 * The map as columns. By page: General (the whole product) first, then each
 * screen with something on it, in sitemap order. By topic: a column per topic,
 * left to right by name, no topic last. Open gaps sit in their column as
 * ghost cards.
 */
export function buildBoard(nodes: GNode[], gaps: Gap[], stories: Story[], options: { groupBy?: GroupBy; cardGroup?: CardGroup; screens?: Screen[]; scope?: Screen | null } = {}): Board {
  const screens = options.screens ?? []
  const cardGroup = options.cardGroup ?? 'level'
  const groupBy: GroupBy = options.groupBy === 'page' && screens.length ? 'page' : 'topic'
  const open = gaps.filter((g) => !g.answered_by)
  const item = (n: GNode): BoardItem => ({ kind: 'node', id: n.id, node: n, altitude: altitudeOf(n.altitude) })
  const ghost = (g: Gap): BoardItem => ({ kind: 'gap', id: `gap:${g.id}`, gap: g, altitude: altitudeOf(g.altitude) })

  if (groupBy === 'topic') {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const columns = [...topicColumns([...nodes, ...open]).values()].map((c) => {
      const mine = nodes.filter((n) => topicKey(n.topic) === c.key)
      const ghosts = open.filter((g) => topicKey(g.topic) === c.key)
      const items = [...mine.map(item), ...ghosts.map(ghost)].sort(byLevel)
      // Working on one part, the topic columns all belong to its screen: its features apply.
      const scope = options.scope ?? undefined
      return {
        key: c.key,
        name: c.name,
        path: '',
        count: mine.length,
        missing: ghosts.length,
        items,
        sections: sectionsOf(items, cardGroup, scope),
        screen: scope?.id ?? '',
        stories: stories.filter((st) => {
          const first = byId.get(st.from[0])
          return !!first && topicKey(first.topic) === c.key
        }),
      }
    })
    return { groupBy, cardGroup, columns }
  }

  const where = new Map(nodes.map((n) => [n.id, screenOf(n, screens)]))
  const known = new Set(screens.map((s) => s.id))
  const gapScreen = (g: Gap) => (g.screen && known.has(g.screen) ? g.screen : '')
  const byId = new Map(screens.map((s) => [s.id, s]))
  const pathOf = (s: Screen) => {
    const names: string[] = []
    let p = s.parent ? byId.get(s.parent) : undefined
    while (p && names.length < 6) {
      names.unshift(p.title)
      p = p.parent ? byId.get(p.parent) : undefined
    }
    return names.join(' › ')
  }
  // A story goes under the first screen that covers it, or General.
  const storyAt = new Map<string, string>()
  for (const st of stories) storyAt.set(st.id, screenTree(screens).find(({ screen }) => storiesForScreen(screen, [st]).length)?.screen.id ?? '')

  const column = (key: string, name: string, path: string): BoardColumn => {
    const mine = nodes.filter((n) => where.get(n.id) === key)
    const ghosts = open.filter((g) => gapScreen(g) === key)
    const items = [...mine.map(item), ...ghosts.map(ghost)].sort(byLevel)
    return {
      key,
      name,
      path,
      count: mine.length,
      missing: ghosts.length,
      items,
      sections: sectionsOf(items, cardGroup, byId.get(key)),
      screen: key,
      stories: stories.filter((st) => storyAt.get(st.id) === key),
    }
  }
  const columns = [column('', 'General', ''), ...screenTree(screens).map(({ screen }) => column(screen.id, screen.title, pathOf(screen)))]
  // Screens with nothing on them yet stay out of the way; General always shows.
  return { groupBy, cardGroup, columns: columns.filter((c, i) => i === 0 || c.items.length || c.stories.length) }
}

export interface OutlineSection {
  key: string
  name: string
  path: string
  /** Altitude levels that hold something, highest first; or the sections of the card grouping, by name. */
  levels: { altitude: number; word: string; items: BoardItem[] }[]
  count: number
}

/** The map as a document: a section per column, its thoughts from vision down to detail. */
export function buildOutline(board: Board): OutlineSection[] {
  return board.columns
    .filter((c) => c.items.length)
    .map((c) => ({
      key: c.key,
      name: c.name,
      path: c.path,
      count: c.count,
      levels:
        board.cardGroup === 'level'
          ? [5, 4, 3, 2, 1].map((altitude) => ({ altitude, word: ALTITUDE_WORDS[altitude], items: c.items.filter((i) => i.altitude === altitude) })).filter((l) => l.items.length)
          : c.sections.filter((sec) => sec.items.length).map((sec, i) => ({ altitude: -i, word: sec.name, items: sec.items })),
    }))
}

/** The first line of a thought's notes, without images, links or the thread. */
export function firstLine(body: string): string {
  const notes = body.split(/^## Thread\s*$/m)[0]
  for (const raw of notes.split('\n')) {
    const line = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[#>*\-\s]+/, '').trim()
    if (line) return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line
  }
  return ''
}
