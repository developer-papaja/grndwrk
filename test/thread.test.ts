import { describe, expect, it } from 'vitest'
import { appendEntry, openQuestions, questionOptions, replaceNotes, splitBody } from '../src/shared/thread.js'

const body = `Free notes here.

## Thread

**Claude asks** · 2026-10-03
Does "not too deep" mean one panel?

**You** · 2026-10-03
Yes, one panel.
Never a second layer.

**Claude asks** · 2026-10-03
And the list, can it stay open?
`

describe('thread', () => {
  it('splits notes from entries', () => {
    const { notes, entries } = splitBody(body)
    expect(notes).toBe('Free notes here.')
    expect(entries.map((e) => [e.who, e.open])).toEqual([['claude-asks', false], ['you', false], ['claude-asks', true]])
    expect(entries[1].text).toBe('Yes, one panel.\nNever a second layer.')
  })

  it('counts a question as open until anything follows it', () => {
    expect(openQuestions(body)).toBe(1)
    expect(openQuestions(appendEntry(body, 'claude', 'Answered in the session.', '2026-10-04'))).toBe(0)
    expect(openQuestions('Just notes')).toBe(0)
  })

  it('reads loose hand edits', () => {
    const loose = 'notes\n\n##   thread\n**claude asks** - 2026-10-03\n  Why?\n'
    expect(splitBody(loose).entries).toEqual([{ who: 'claude-asks', date: '2026-10-03', text: 'Why?', open: true }])
  })

  it('replaces notes and leaves the thread untouched, round trip safe while typing', () => {
    const next = replaceNotes(body, 'New notes\n')
    expect(next.endsWith(body.slice(body.indexOf('## Thread')))).toBe(true)
    expect(splitBody(next).notes).toBe('New notes\n')
    expect(splitBody(replaceNotes(body, '')).notes).toBe('')
    expect(replaceNotes('old', 'new')).toBe('new')
  })

  it('starts a thread when there is none', () => {
    expect(appendEntry('Notes.\n', 'you', 'A reply', '2026-10-03')).toBe('Notes.\n\n## Thread\n\n**You** · 2026-10-03\nA reply\n')
    expect(appendEntry('', 'claude-asks', 'Why?', '2026-10-03')).toBe('## Thread\n\n**Claude asks** · 2026-10-03\nWhy?\n')
    const twice = appendEntry(appendEntry('', 'claude-asks', 'Why?', 'd'), 'you', 'Because.', 'd')
    expect(splitBody(twice).entries.map((e) => e.text)).toEqual(['Why?', 'Because.'])
  })

  it('reads the options under a question', () => {
    const text = 'Which type scale?\n\nOptions:\n- 12, 13, 15 and 20\n- Tailwind default\n* A third'
    expect(questionOptions(text)).toEqual({ question: 'Which type scale?', options: ['12, 13, 15 and 20', 'Tailwind default', 'A third'] })
    expect(questionOptions('Plain question?')).toEqual({ question: 'Plain question?', options: [] })
  })
})
