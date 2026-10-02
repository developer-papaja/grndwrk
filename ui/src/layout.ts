/** Where things sit in the map. Pure functions, so the rules are easy to test. */

/** Height between two altitude levels. */
export const ALTITUDE_STEP = 70
/** Sideways distance between topic columns. */
export const COLUMN_SPACING = 240
/** How much a link that crosses topics pulls, compared to one inside a topic. */
export const CROSS_TOPIC_PULL = 0.1
/** Labels wrap onto at most two lines of about this many characters. */
export const LABEL_LINE = 22

export const ALTITUDE_WORDS: Record<number, string> = {
  5: 'vision',
  4: 'principle',
  3: 'approach',
  2: 'feature',
  1: 'detail',
}

/** Altitude 5 sits highest, 1 lowest, 3 in the middle. */
export function altitudeY(altitude: number): number {
  return (Math.min(5, Math.max(1, altitude)) - 3) * ALTITUDE_STEP
}

/** Topics match regardless of case and spacing. An empty key means no topic. */
export function topicKey(topic: string | undefined): string {
  return (topic ?? '').trim().toLowerCase()
}

export interface Column {
  key: string
  /** The name as first written, or "no topic". */
  name: string
  x: number
}

/**
 * One column per topic, left to right by name, centered on zero.
 * Nodes without a topic share a column at the far right.
 */
export function topicColumns(nodes: { topic?: string }[]): Map<string, Column> {
  const names = new Map<string, string>()
  for (const n of nodes) {
    const key = topicKey(n.topic)
    if (!names.has(key)) names.set(key, key ? n.topic!.trim() : 'no topic')
  }
  const keys = [...names.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  return new Map(
    keys.map((key, i) => [key, { key, name: names.get(key)!, x: (i - (keys.length - 1) / 2) * COLUMN_SPACING }]),
  )
}

/** Link pull, following d3's default of weakening links on busy nodes. */
export function linkStrength(sameTopic: boolean, degreeA: number, degreeB: number): number {
  const base = 1 / Math.max(1, Math.min(degreeA, degreeB))
  return sameTopic ? base : base * CROSS_TOPIC_PULL
}

/** Two short lines read better in a crowded map than one long one. */
export function wrapLabel(title: string): string {
  const words = title.trim().split(/\s+/)
  const lines: string[] = ['']
  for (const word of words) {
    const line = lines[lines.length - 1]
    if (!line || line.length + 1 + word.length <= LABEL_LINE) lines[lines.length - 1] = line ? `${line} ${word}` : word
    else if (lines.length < 2) lines.push(word)
    else {
      lines[1] = `${lines[1]} ${word}`
      break
    }
  }
  if (lines[1] && (lines[1].length > LABEL_LINE || words.join(' ').length > lines.join(' ').length)) {
    lines[1] = `${lines[1].slice(0, LABEL_LINE - 1).trimEnd()}…`
  }
  return lines.join('\n')
}
