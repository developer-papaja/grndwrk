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

export function testSteps(text: string): { fix: string; steps: string[]; checks: (StepCheck | null)[] } {
  const m = /^[ \t]*(?:to test|how to test)[ \t]*:[ \t]*/im.exec(text)
  if (!m) return { fix: text.trim(), steps: [], checks: [] }
  const raw: string[] = []
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const start = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line)
    if (start) raw.push(start[1].trim())
    else if (line.trim() && raw.length) raw[raw.length - 1] += ` ${line.trim()}`
    else if (line.trim()) raw.push(line.trim())
  }
  const read = raw.map(stepCheck)
  return { fix: text.slice(0, m.index).trim(), steps: read.map((r) => r.text), checks: read.map((r) => r.check) }
}

/**
 * How far the agent checked a step itself, written at the end of the step:
 * `[automated: AppointmentsTest.showsSpecies]` (a test that ran and passed),
 * `[agent: checked in the emulator]` (the agent tried it), or
 * `[outdated: the Settings screen is gone]` (the step no longer fits). A step
 * without one is left for the person. Every step is still the person's to
 * mark Works or No; this only says where their attention matters most.
 */
export type StepCheckKind = 'automated' | 'agent' | 'outdated'
export interface StepCheck {
  kind: StepCheckKind
  note: string
}

export function stepCheck(step: string): { text: string; check: StepCheck | null } {
  const m = /\s*\[(automated|agent|outdated)(?:\s*:\s*([^[\]\n]{0,300}))?\]\s*$/i.exec(step)
  if (!m || m.index === 0) return { text: step, check: null }
  return { text: step.slice(0, m.index).trim(), check: { kind: m[1].toLowerCase() as StepCheckKind, note: (m[2] ?? '').trim() } }
}

/** One line on how far the steps were checked: "1 tested automatically, 1 checked by your agent, 1 left for you". Empty when none was. */
export function checkSummary(checks: (StepCheck | null)[]): string {
  const count = (k: StepCheckKind) => checks.filter((c) => c?.kind === k).length
  const auto = count('automated')
  const agent = count('agent')
  const old = count('outdated')
  if (!auto && !agent && !old) return ''
  const left = checks.length - auto - agent - old
  const parts = [
    auto && `${auto} tested automatically`,
    agent && `${agent} checked by your agent`,
    old && `${old} ${old === 1 ? 'looks' : 'look'} out of date`,
    left ? `${left} left for you` : 'nothing left but a final look from you',
  ].filter(Boolean)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1) + '.'
}
