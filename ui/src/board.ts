import type { Gap, GNode, Story } from '../../src/shared/types'
import { ALTITUDE_WORDS, topicColumns, topicKey } from './layout'

/** How the map draws its cards. The same files and the same meaning, drawn two ways. */
export type MapLayout = 'board' | 'outline'
export const MAP_LAYOUTS: { key: MapLayout; name: string; icon: string }[] = [
  { key: 'board', name: 'Board: topics as columns, altitude as rows', icon: 'i-columns' },
  { key: 'outline', name: 'Outline: topics as sections, to read through', icon: 'i-outline' },
]

export interface BoardColumn {
  key: string
  name: string
  count: number
  /** Open gaps in this topic. */
  missing: number
}

export interface BoardCell {
  column: string
  nodes: GNode[]
  gaps: Gap[]
}

export interface BoardRow {
  altitude: number
  word: string
  cells: BoardCell[]
}

export interface Board {
  columns: BoardColumn[]
  rows: BoardRow[]
  /** Stories under each column, in the column of their first source thought. */
  stories: Story[][]
}

const time = (n: GNode) => (n.modified ? Date.parse(n.modified) : Number.POSITIVE_INFINITY)
/** Newest first, so what changed lately sits at the top of its cell. */
const newestFirst = (a: GNode, b: GNode) => time(b) - time(a) || a.title.localeCompare(b.title)
const altitudeOf = (a: number | undefined) => Math.min(5, Math.max(1, Math.round(a ?? 3)))

/**
 * The map as a grid: a column per topic, left to right by name, and a
 * row per altitude from vision down to detail. Open gaps sit in their cell as
 * ghost cards. A topic only gaps point at still gets a column.
 */
export function buildBoard(nodes: GNode[], gaps: Gap[], stories: Story[]): Board {
  const open = gaps.filter((g) => !g.answered_by)
  const cols = [...topicColumns([...nodes, ...open]).values()]
  const columns = cols.map((c) => ({
    key: c.key,
    name: c.name,
    count: nodes.filter((n) => topicKey(n.topic) === c.key).length,
    missing: open.filter((g) => topicKey(g.topic) === c.key).length,
  }))
  const rows = [5, 4, 3, 2, 1].map((altitude) => ({
    altitude,
    word: ALTITUDE_WORDS[altitude],
    cells: cols.map((c) => ({
      column: c.key,
      nodes: nodes.filter((n) => topicKey(n.topic) === c.key && altitudeOf(n.altitude) === altitude).sort(newestFirst),
      gaps: open.filter((g) => topicKey(g.topic) === c.key && altitudeOf(g.altitude) === altitude),
    })),
  }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const storyCols = cols.map((c) => stories.filter((st) => {
    const first = byId.get(st.from[0])
    return !!first && topicKey(first.topic) === c.key
  }))
  return { columns, rows, stories: storyCols }
}

export interface OutlineSection {
  key: string
  name: string
  /** Altitude levels that hold something, highest first. */
  levels: { altitude: number; word: string; nodes: GNode[]; gaps: Gap[] }[]
  count: number
}

/** The map as a document: a section per topic, its thoughts from vision down to detail. */
export function buildOutline(nodes: GNode[], gaps: Gap[]): OutlineSection[] {
  const board = buildBoard(nodes, gaps, [])
  return board.columns.map((col, i) => ({
    key: col.key,
    name: col.name,
    count: col.count,
    levels: board.rows
      .map((r) => ({ altitude: r.altitude, word: r.word, nodes: r.cells[i].nodes, gaps: r.cells[i].gaps }))
      .filter((l) => l.nodes.length || l.gaps.length),
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
