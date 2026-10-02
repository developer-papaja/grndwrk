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
 * group, abstract nodes come first. A query matches title, notes or topic.
 */
export function groupForList(nodes: GNode[], query: string): ListGroup[] {
  const q = query.trim().toLowerCase()
  const matches = (n: GNode) =>
    !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || n.topic.toLowerCase().includes(q)

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
