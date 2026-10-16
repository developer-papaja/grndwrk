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
