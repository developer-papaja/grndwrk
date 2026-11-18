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
  // Written exactly as the rules say, lower case with a colon, so a label in brackets ("Tap [Agent]") is never one.
  // Only the end of the step is searched, and the pattern starts at a literal "[", so a long step stays fast.
  const end = step.trimEnd()
  const tail = end.slice(-400)
  const m = /\[(automated|agent|outdated):([^[\]\n]{0,300})\]$/.exec(tail)
  if (!m) return { text: step, check: null }
  const text = end.slice(0, end.length - tail.length + m.index).trim()
  if (!text) return { text: step, check: null }
  return { text, check: { kind: m[1] as StepCheckKind, note: m[2].trim() } }
}

/**
 * Marks for steps written in an earlier entry, without writing them again: a
 * later agent entry with a `Checked:` line, then one line per step, its number
 * and the mark (`1. [automated: KeysUITests.otherPlaces]`, or `Step 2: [agent:
 * tried it in the Simulator]`). Read from the `Checked:` line to the first
 * line that is no such mark.
 */
export function checkedSteps(text: string): Map<number, StepCheck> {
  const marks = new Map<number, StepCheck>()
  const m = /^[ \t]*checked[ \t]*:[ \t]*$/im.exec(text)
  if (!m) return marks
  for (const line of text.slice(m.index + m[0].length).split('\n').slice(0, 60)) {
    if (!line.trim()) continue
    // A mark line is short; a long one is something else, and is never matched (a line of
    // spaces made the pattern below slow enough to stop the map's server).
    if (line.length > 400) break
    // One way only to split the space between the number and the mark, so no line is slow.
    const r = /^[ \t]*(?:[-*][ \t]+)?(?:step[ \t]+)?(\d{1,2})(?:[.):][ \t]*|[ \t]+)(\[(?:automated|agent|outdated):[^[\]\n]{0,300}\])[ \t]*$/i.exec(line)
    if (!r) break
    const check = stepCheck(`step ${r[2]}`).check
    if (check && Number(r[1]) >= 1) marks.set(Number(r[1]) - 1, check)
  }
  return marks
}

/**
 * How far the agent checked each step of entry `at`'s To test list: the marks
 * on the steps themselves, then any a later agent entry of the same round gives
 * in its `Checked:` section (the later one wins). A round ends at the next
 * entry with steps or at a "Tested ..." entry.
 */
export function roundChecks(entries: { who: string; text: string }[], at: number): (StepCheck | null)[] {
  const own = testSteps(entries[at]?.text ?? '')
  const checks = [...own.checks]
  for (const e of entries.slice(at + 1)) {
    if (e.who === 'you' && /^\s*Tested\b/.test(e.text)) break
    if (e.who !== 'claude') continue
    if (testSteps(e.text).steps.length) break
    for (const [n, c] of checkedSteps(e.text)) if (n < checks.length) checks[n] = c
  }
  return checks
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
