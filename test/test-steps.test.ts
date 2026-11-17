import { describe, expect, it } from 'vitest'
import { checkSummary, stepCheck, testEntryIndex, testSteps } from '../src/shared/feedback.js'
import { lastFix } from '../src/server/feedback.js'

describe('testSteps', () => {
  it('splits what changed from numbered steps, joining the lines under a step', () => {
    const t = testSteps('Rooms show now (abc123).\n\nTo test:\n1. In Ask, send "What meetings".\nYour meetings show.\n2. Tap Book: the sheet opens.\n')
    expect(t.fix).toBe('Rooms show now (abc123).')
    expect(t.steps).toEqual(['In Ask, send "What meetings". Your meetings show.', 'Tap Book: the sheet opens.'])
  })
  it('takes dashes and a step on the same line as To test', () => {
    expect(testSteps('Done.\nTo test: open Settings\n- tap Save').steps).toEqual(['open Settings', 'tap Save'])
  })
  it('has no steps without a To test line', () => {
    expect(testSteps('Proposed: move the button.')).toEqual({ fix: 'Proposed: move the button.', steps: [], checks: [] })
  })
})

describe('the entry to test now', () => {
  const steps = { who: 'claude', text: 'Bigger button.\n\nTo test:\n1. Open a visit.\n2. Tap Save.' }
  it('is Claude’s latest entry with steps, even with a note from Claude after it', () => {
    expect(testEntryIndex([{ who: 'you', text: 'Save is hidden' }, steps])).toBe(1)
    expect(testEntryIndex([steps, { who: 'claude', text: 'Checked it end to end. The steps above still hold.' }])).toBe(0)
    expect(testEntryIndex([steps, { who: 'you', text: 'A remark' }])).toBe(0)
  })
  it('is none once that round was tested, or when no entry has steps', () => {
    expect(testEntryIndex([steps, { who: 'you', text: 'Tested on the Mac: it does not work.' }])).toBe(-1)
    expect(testEntryIndex([{ who: 'claude', text: 'Proposed: move it.' }])).toBe(-1)
    // A new round after a test: its own steps.
    expect(testEntryIndex([steps, { who: 'you', text: 'Tested on the phone: rejected.' }, { ...steps, text: 'Moved it.\n\nTo test:\n1. Open a visit.' }])).toBe(2)
  })
  it('is what the phone and the web button are given to test', () => {
    const body = `Save is hidden.\n\n## Thread\n\n**Claude** · 2026-11-09\n${steps.text}\n\n**Claude** · 2026-11-09\nChecked it end to end. The steps above still hold.\n`
    expect(lastFix(body)).toEqual({ fix: 'Bigger button.', test: '1. Open a visit.\n2. Tap Save.' })
  })
})

describe('how far the agent checked each step', () => {
  const entry = [
    'Each card shows the species.',
    '',
    'To test:',
    '1. Open Appointments. [automated: AppointmentsTest.showsSpecies]',
    '2. Each card shows "Max (dog)". [agent: checked in the emulator]',
    '3. Open the old Species tab. [outdated: the tab was removed in this change]',
    '4. Search for "dog": only dogs are listed.',
  ].join('\n')

  it('reads the mark at the end of a step, and leaves the step without it', () => {
    const t = testSteps(entry)
    expect(t.steps).toEqual(['Open Appointments.', 'Each card shows "Max (dog)".', 'Open the old Species tab.', 'Search for "dog": only dogs are listed.'])
    expect(t.checks).toEqual([
      { kind: 'automated', note: 'AppointmentsTest.showsSpecies' },
      { kind: 'agent', note: 'checked in the emulator' },
      { kind: 'outdated', note: 'the tab was removed in this change' },
      null,
    ])
  })

  it('says in one line what is left for the person', () => {
    expect(checkSummary(testSteps(entry).checks)).toBe('1 tested automatically, 1 checked by your agent, 1 looks out of date, 1 left for you.')
    expect(checkSummary([{ kind: 'automated', note: '' }, { kind: 'automated', note: 'x' }])).toBe('2 tested automatically, nothing left but a final look from you.')
    expect(checkSummary([null, null])).toBe('')
  })

  it('takes only its own marks, at the very end, and never a whole step', () => {
    expect(stepCheck('Tap [Save] and check the list').check).toBeNull()
    expect(stepCheck('Tap Save [automated]').check).toEqual({ kind: 'automated', note: '' })
    expect(stepCheck('Tap Save [AGENT: looked at it]').check).toEqual({ kind: 'agent', note: 'looked at it' })
    expect(stepCheck('[automated: x]').check).toBeNull()
    expect(stepCheck('Tap Save [automated: x] then more').check).toBeNull()
    expect(stepCheck('Tap Save [verified: x]').check).toBeNull()
  })
})
