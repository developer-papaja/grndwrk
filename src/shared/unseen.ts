import { isFeedback, isFixed } from './feedback.js'
import type { GNode } from './types.js'

/**
 * New comments: the ones that came through the relay, from a colleague's
 * phone away from the Wi-Fi, which nobody sees arrive. A comment is new for
 * this browser when all of these hold:
 *
 * - it came through the relay (`via: relay`) and is not fixed
 * - it was not opened in this browser (kept per person in localStorage)
 * - nobody on the team opened it yet (no `seen:` on it), or it arrived while
 *   this tab was open (someone else opening it then does not hide it from you)
 *
 * Opening it in the panel marks it seen in this browser and, the first time
 * anyone opens it, writes `seen: <date>` on the comment, one line, committed.
 */
export const isRelayComment = (n: GNode): boolean => isFeedback(n) && n.extra?.via === 'relay' && !n.error

export interface SeenHere {
  /** Comments opened in this browser. */
  opened: ReadonlySet<string>
  /** Comments that arrived while this tab was open. */
  arrived: ReadonlySet<string>
}

export function isNewComment(n: GNode, here: SeenHere): boolean {
  if (!isRelayComment(n) || isFixed(n) || here.opened.has(n.id)) return false
  return !n.extra?.seen || here.arrived.has(n.id)
}

/** Whether opening this comment should write `seen:` on it: a relay comment nobody opened yet. */
export const needsSeen = (n: GNode): boolean => isRelayComment(n) && !n.extra?.seen
