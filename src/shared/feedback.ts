import type { GNode } from './types.js'

/**
 * A comment from the running product moves through three states:
 *
 * - incoming: nobody has proposed what to do about it yet
 * - proposed: Claude proposed a fix in the thread, not built yet (`proposed: <date>`)
 * - ready: the fix is built, so it can be tested in the running product (`built: <date>`).
 *   Claude's entry in the thread says what changed and, after "To test:", how to check it.
 * - fixed: the person marked it fixed (`fixed: <date>`). Claude never sets this on its own.
 *
 * Fixed comments stay in the files but leave the map until asked for.
 */
export type FeedbackState = 'incoming' | 'proposed' | 'ready' | 'fixed'
export const FEEDBACK_STATES: FeedbackState[] = ['incoming', 'proposed', 'ready', 'fixed']

export const isFeedback = (n: GNode): boolean => n.extra?.source === 'app'

/** The state of a comment, or null for a thought that is not one. */
export function feedbackState(n: GNode): FeedbackState | null {
  if (!isFeedback(n)) return null
  if (n.extra?.fixed) return 'fixed'
  if (n.extra?.built) return 'ready'
  if (n.extra?.proposed) return 'proposed'
  return 'incoming'
}

export const isFixed = (n: GNode): boolean => feedbackState(n) === 'fixed'

/**
 * A Claude entry split at its "To test:" line: what changed, and the steps,
 * one per numbered (or `- `) line, with the lines under a step joined to it.
 * Steps is empty when the entry has no "To test:" line.
 */
export function testSteps(text: string): { fix: string; steps: string[] } {
  const m = /^[ \t]*(?:to test|how to test)[ \t]*:[ \t]*/im.exec(text)
  if (!m) return { fix: text.trim(), steps: [] }
  const steps: string[] = []
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const start = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line)
    if (start) steps.push(start[1].trim())
    else if (line.trim() && steps.length) steps[steps.length - 1] += ` ${line.trim()}`
    else if (line.trim()) steps.push(line.trim())
  }
  return { fix: text.slice(0, m.index).trim(), steps }
}
