import type { GNode } from '../../src/shared/types'
import { topicColumns, topicKey } from './layout'

export interface ListGroup {
  key: string
  name: string
  /** All nodes in this topic, so thin topics show even while filtering. */
  total: number
  nodes: GNode[]
}

/**
 * Nodes grouped by topic in the same order as the map's columns. Within a
 * group, abstract nodes come first. A query matches the id (people name
 * thoughts to their agent by it), title, summary, notes or topic.
 */
export function matchesQuery(n: GNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  return (
    !q ||
    n.id.toLowerCase().includes(q) ||
    n.title.toLowerCase().includes(q) ||
    String(n.extra?.summary ?? '').toLowerCase().includes(q) ||
    n.body.toLowerCase().includes(q) ||
    n.topic.toLowerCase().includes(q)
  )
}

export function groupForList(nodes: GNode[], query: string): ListGroup[] {
  const q = query.trim().toLowerCase()
  const matches = (n: GNode) => matchesQuery(n, q)

  const groups: ListGroup[] = []
  for (const col of topicColumns(nodes).values()) {
    const inTopic = nodes.filter((n) => topicKey(n.topic) === col.key)
    const shown = inTopic
      .filter(matches)
      .sort((a, b) => b.altitude - a.altitude || a.title.localeCompare(b.title))
    if (q && shown.length === 0) continue
    groups.push({ key: col.key, name: col.name, total: inTopic.length, nodes: shown })
  }
  return groups
}

/** The rows in display order, for moving through the list with the arrow keys. */
export function flatten(groups: ListGroup[]): GNode[] {
  return groups.flatMap((g) => g.nodes)
}

/**
 * Thoughts the filters or the page keep out of view whose id holds the query:
 * an id is looked up to find that one thought, wherever it is and however it
 * stands. Four characters at least, so a short word finds no stray ids.
 */
export function byIdOutOfView(all: GNode[], inView: GNode[], query: string): GNode[] {
  const q = query.trim().toLowerCase()
  if (q.length < 4) return []
  const shown = new Set(inView.map((n) => n.id))
  return all.filter((n) => !shown.has(n.id) && n.id.toLowerCase().includes(q))
}
