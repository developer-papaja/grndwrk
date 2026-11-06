import { describe, expect, it } from 'vitest'
import { testSteps } from '../src/shared/feedback.js'

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
