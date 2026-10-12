/** Where things sit in the map. Pure functions, so the rules are easy to test. */

export const ALTITUDE_WORDS: Record<number, string> = {
  5: 'vision',
  4: 'principle',
  3: 'approach',
  2: 'feature',
  1: 'detail',
}

/**
 * How a topic or area name is shown: first letter capitalised ("Look and
 * feel"). Files keep what was written; topics match regardless of case.
 */
export function displayName(name: string): string {
  const t = name.trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

/** Topics match regardless of case and spacing. An empty key means no topic. */
export function topicKey(topic: string | undefined): string {
  return (topic ?? '').trim().toLowerCase()
}

export interface Column {
  key: string
  /** The name as first written, or "no topic". */
  name: string
}

/**
 * One column per topic, left to right by name.
 * Nodes without a topic share a column at the far right.
 */
export function topicColumns(nodes: { topic?: string }[]): Map<string, Column> {
  const names = new Map<string, string>()
  for (const n of nodes) {
    const key = topicKey(n.topic)
    if (!names.has(key)) names.set(key, key ? n.topic!.trim() : 'no topic')
  }
  const keys = [...names.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  return new Map(keys.map((key) => [key, { key, name: names.get(key)! }]))
}
