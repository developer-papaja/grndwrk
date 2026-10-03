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
export function altitudeY(altitude: number, step = ALTITUDE_STEP): number {
  return (Math.min(5, Math.max(1, altitude)) - 3) * step
}

/**
 * Space between altitude levels so the map keeps about the shape of the view.
 * More topic columns make the map wider, so the levels spread further apart
 * and cards get room on screen instead of turning into dots.
 */
export function altitudeStep(columnCount: number, viewAspect: number): number {
  const width = Math.max(0, columnCount - 1) * COLUMN_SPACING + 220
  const step = width / Math.max(0.5, viewAspect) / 4.6
  return Math.round(Math.min(260, Math.max(ALTITUDE_STEP, step)))
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
export function wrapLabel(title: string, lineLength = LABEL_LINE): string {
  const words = title.trim().split(/\s+/)
  const lines: string[] = ['']
  for (const word of words) {
    const line = lines[lines.length - 1]
    if (!line || line.length + 1 + word.length <= lineLength) lines[lines.length - 1] = line ? `${line} ${word}` : word
    else if (lines.length < 2) lines.push(word)
    else {
      lines[1] = `${lines[1]} ${word}`
      break
    }
  }
  if (lines[1] && (lines[1].length > lineLength || words.join(' ').length > lines.join(' ').length)) {
    lines[1] = `${lines[1].slice(0, lineLength - 1).trimEnd()}…`
  }
  return lines.join('\n')
}

/** How far in front of and behind the middle the newest and oldest nodes sit. */
export const DEPTH_RANGE = 120

/**
 * How old each node is compared to the others: 0 for the most recently
 * changed, 1 for the one untouched the longest. A node with no time yet
 * (just created) counts as newest.
 */
export function ageFractions(nodes: { id: string; modified?: string }[]): Map<string, number> {
  const time = (n: { modified?: string }) => (n.modified ? Date.parse(n.modified) : Number.POSITIVE_INFINITY)
  const sorted = [...nodes].sort((a, b) => time(b) - time(a))
  const last = Math.max(1, sorted.length - 1)
  return new Map(sorted.map((n, i) => [n.id, sorted.length === 1 ? 0 : i / last]))
}

/** Newest in front, toward the camera. Oldest at the back. */
export function depthZ(age: number): number {
  return (0.5 - age) * 2 * DEPTH_RANGE
}

/** Older cards are a little dimmer, so time also reads from straight in front. */
export function ageOpacity(age: number): number {
  return 1 - 0.4 * age
}
