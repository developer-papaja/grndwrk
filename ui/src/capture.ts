import type { NodeType } from '../../src/shared/types'

const PREFIXES: Record<string, NodeType> = { '?': 'question', '!': 'decision' }

/**
 * Turn what was typed in the capture bar into a node. A leading `?` makes a
 * question and `!` a decision, with or without a space after it.
 * Returns null when there is nothing to capture.
 */
export function parseCapture(raw: string): { title: string; type?: NodeType } | null {
  const text = raw.trim()
  const type = PREFIXES[text[0]]
  if (type) {
    const title = text.slice(1).trim()
    return title ? { title, type } : null
  }
  return text ? { title: text } : null
}

/** Titles count as the same when they only differ in case, spacing or a trailing period. */
export function sameTitle(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  return norm(a) === norm(b)
}
