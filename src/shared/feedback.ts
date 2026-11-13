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
/**
 * Which thread entry holds the steps to test now: Claude's latest entry with
 * a "To test:" list, even when Claude added a note without steps after it
 * ("the steps above still hold"). A "Tested ..." entry after it means that
 * round is done: then none (-1).
 */
export function testEntryIndex(entries: { who: string; text: string }[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.who === 'you' && /^\s*Tested\b/.test(e.text)) return -1
    if (e.who === 'claude' && testSteps(e.text).steps.length) return i
  }
  return -1
}

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
