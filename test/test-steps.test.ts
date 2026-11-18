import { describe, expect, it } from 'vitest'
import { checkedSteps, checkSummary, roundChecks, stepCheck, testEntryIndex, testSteps } from '../src/shared/feedback.js'
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
  })

  it('stays fast on a step that is very long or ends in a long run of spaces', () => {
    const t = Date.now()
    expect(stepCheck(`Open it.${' '.repeat(200_000)}`).check).toBeNull()
    expect(stepCheck(`${'x'.repeat(200_000)} [agent: looked]`).check).toEqual({ kind: 'agent', note: 'looked' })
    expect(Date.now() - t).toBeLessThan(200)
    expect(checkSummary([null, null])).toBe('')
  })

  it('takes only its own marks, at the very end, and never a whole step', () => {
    expect(stepCheck('Tap [Save] and check the list').check).toBeNull()
    // Exactly as written in the rules: lower case, with a colon. A label in brackets is never one (review of 2026-11-17).
    expect(stepCheck('Tap the button labelled [Agent]').check).toBeNull()
    expect(stepCheck('Tap Save [automated]').check).toBeNull()
    expect(stepCheck('Tap Save [AGENT: looked at it]').check).toBeNull()
    expect(stepCheck('Tap Save [agent: looked at it]').check).toEqual({ kind: 'agent', note: 'looked at it' })
    expect(stepCheck('Tap Save [automated:]').check).toEqual({ kind: 'automated', note: '' })
    expect(stepCheck('[automated: x]').check).toBeNull()
    expect(stepCheck('Tap Save [automated: x] then more').check).toBeNull()
    expect(stepCheck('Tap Save [verified: x]').check).toBeNull()
  })
})

describe('marks given later, by step number', () => {
  const steps = { who: 'claude', text: 'Other places is a row now.\n\nTo test:\n1. Open Keys: an Other places row.\n2. Tap it: a screen of its own.\n3. Back returns to Keys.' }
  const later = { who: 'claude', text: 'Ran the UI test on the Simulator.\n\nChecked:\n1. [automated: KeysUITests.otherPlaces]\nStep 3: [agent: tried it, screenshot]\n\n![](../../files/n_x/shot.png)' }

  it('reads a Checked: section, number and mark per line, up to the first other line', () => {
    const m = checkedSteps(later.text)
    expect([...m.keys()]).toEqual([0, 2])
    expect(m.get(0)).toEqual({ kind: 'automated', note: 'KeysUITests.otherPlaces' })
    expect(checkedSteps('Checked:\n1. [automated: A]\nsomething else\n2. [agent: B]').size).toBe(1)
    expect(checkedSteps('Checked:\n1. Tap [Agent] in the bar').size).toBe(0)
    expect(checkedSteps('I checked: 1. [automated: A]').size).toBe(0)
  })

  it('puts them on the steps of the round, without starting a new one', () => {
    const entries = [steps, later]
    expect(testEntryIndex(entries)).toBe(0)
    expect(roundChecks(entries, 0)).toEqual([{ kind: 'automated', note: 'KeysUITests.otherPlaces' }, null, { kind: 'agent', note: 'tried it, screenshot' }])
  })

  it('stops at a new round or a test result, and ignores numbers past the steps', () => {
    expect(roundChecks([steps, { who: 'you', text: 'Tested on the Mac: does not work yet.' }, later], 0)).toEqual([null, null, null])
    expect(roundChecks([steps, { who: 'claude', text: 'To test:\n1. Something new.' }, later], 0)).toEqual([null, null, null])
    expect(roundChecks([steps, { who: 'claude', text: 'Checked:\n9. [automated: X]' }], 0)).toEqual([null, null, null])
  })

  it('reaches the phone and the web button through lastFix', () => {
    const body = `Notes.\n\n## Thread\n\n**Claude** · 2026-11-17\n${steps.text}\n\n**Claude** · 2026-11-18\n${later.text}\n`
    const f = lastFix(body)
    expect(f.test).toContain('Open Keys')
    expect(f.checks?.[0]?.kind).toBe('automated')
    expect(f.checks?.[2]?.kind).toBe('agent')
  })
})
