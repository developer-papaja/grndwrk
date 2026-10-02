import type { NodeType } from '../../src/shared/types'

const PREFIXES: Record<string, NodeType> = { '?': 'question', '!': 'decision' }

/**
 * Turn what was typed in the capture bar into a node. `? ` makes a question,
 * `! ` makes a decision. Returns null when there is nothing to capture.
 */
export function parseCapture(raw: string): { title: string; type?: NodeType } | null {
  const text = raw.trim()
  const type = PREFIXES[text[0]]
  if (type && (text.length === 1 || /\s/.test(text[1]))) {
    const title = text.slice(1).trim()
    return title ? { title, type } : null
  }
  return text ? { title: text } : null
}
