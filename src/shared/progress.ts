import { feedbackState, isFeedback } from './feedback.js'
import type { GNode, Story } from './types.js'

/**
 * One set of statuses for everything on the map, so one filter shows what is
 * left and hides what is finished, whatever kind it is:
 *
 *   Open          a comment nobody proposed a fix for, a story not started, an open thought
 *   In progress   a fix proposed, a story partly met
 *   Ready to test a fix built, waiting for the person to test it
 *   Done          a comment fixed, a story done, a thought settled
 *   Not now       a thought parked, a story set aside
 *
 * A guiding principle is none of these: it never closes, and the map shows it
 * in the strip above the board instead (`isPrinciple`).
 *
 * The files keep their own words (incoming, partial, settled...); this is
 * only how the map reads them.
 */
export type Progress = 'open' | 'in-progress' | 'ready' | 'done' | 'later'
export const PROGRESS: Progress[] = ['open', 'in-progress', 'ready', 'done', 'later']
export const PROGRESS_WORDS: Record<Progress, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  ready: 'Ready to test',
  done: 'Done',
  later: 'Not now',
}

/** A thought that never closes but steers everything: shown above the board, never on it, and counted nowhere. */
export function isPrinciple(n: GNode): boolean {
  return n.status === 'principle'
}

export function progressOfNode(n: GNode): Progress {
  if (n.status === 'parked') return 'later'
  // Never on the board, so no filter shows it; as settled as a thought gets.
  if (isPrinciple(n)) return 'done'
  if (isFeedback(n)) {
    const st = feedbackState(n)
    return st === 'fixed' ? 'done' : st === 'ready' ? 'ready' : st === 'proposed' ? 'in-progress' : 'open'
  }
  if (n.status === 'settled') return 'done'
  // Any thought the agent built something for waits for the person to test it, like a comment's fix.
  return n.extra?.built ? 'ready' : 'open'
}

export function progressOfStory(s: Story): Progress {
  if (s.later) return 'later'
  return s.status === 'done' ? 'done' : s.status === 'partial' ? 'in-progress' : 'open'
}

/**
 * What the status filter shows: '' everything not finished (open, in progress,
 * ready to test), one status, or 'all'. Only the new comments through the relay
 * is a filter of its own next to it (`newOnly` in the map), not a status.
 */
export type ProgressFilter = '' | Progress | 'all'

export function showsProgress(filter: ProgressFilter, p: Progress): boolean {
  if (filter === 'all') return true
  if (filter === '') return p !== 'done' && p !== 'later'
  return p === filter
}
