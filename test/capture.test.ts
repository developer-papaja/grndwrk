import { describe, expect, it } from 'vitest'
import { parseCapture } from '../ui/src/capture.js'

describe('parseCapture', () => {
  it('makes an idea by default', () => {
    expect(parseCapture('Booking should feel like texting')).toEqual({ title: 'Booking should feel like texting' })
  })
  it('reads the question and decision prefixes', () => {
    expect(parseCapture('? Who books for a team')).toEqual({ title: 'Who books for a team', type: 'question' })
    expect(parseCapture('! No accounts in v1')).toEqual({ title: 'No accounts in v1', type: 'decision' })
  })
  it('trims extra spaces around and after the prefix', () => {
    expect(parseCapture('   ?    Why now  ')).toEqual({ title: 'Why now', type: 'question' })
  })
  it('reads the prefix without a space too', () => {
    expect(parseCapture('?why')).toEqual({ title: 'why', type: 'question' })
    expect(parseCapture('!I think the orbs must look better')).toEqual({ title: 'I think the orbs must look better', type: 'decision' })
  })
  it('returns null when nothing is left', () => {
    expect(parseCapture('')).toBeNull()
    expect(parseCapture('   ')).toBeNull()
    expect(parseCapture('?')).toBeNull()
    expect(parseCapture('!   ')).toBeNull()
  })
})
