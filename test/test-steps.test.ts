import { describe, expect, it } from 'vitest'
import { testEntryIndex, testSteps } from '../src/shared/feedback.js'
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
    expect(testSteps('Proposed: move the button.')).toEqual({ fix: 'Proposed: move the button.', steps: [] })
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
