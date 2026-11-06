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

describe('several questions at once', () => {
  const two = `Notes.

## Thread

**Claude asks** · 2026-10-14
Which screen is this about?

Options:
- Community
- Invitations

**Claude asks** · 2026-10-14
Who sees it?

Options:
- Admins
- Everyone
`

  it('keeps every question in a row open, not only the last', async () => {
    const { questions } = await import('../src/shared/thread.js')
    const qs = questions(two)
    expect(qs.map((q) => [q.question, q.options, q.open])).toEqual([
      ['Which screen is this about?', ['Community', 'Invitations'], true],
      ['Who sees it?', ['Admins', 'Everyone'], true],
    ])
    expect(openQuestions(two)).toBe(2)
    expect(splitBody(two).entries.map((e) => e.open)).toEqual([true, true])
  })

  it('splits one entry that asks several things, each with its own options', async () => {
    const { questions, splitQuestions } = await import('../src/shared/thread.js')
    const one = `Two things about the booking flow.

Which day should it open on?

Options:
- Today
- The last day booked

And should the floor plan show first?

Options:
- Yes
- No, the list

Answer one at a time if that is easier.`
    expect(splitQuestions(one)).toEqual([
      { question: 'Two things about the booking flow.\n\nWhich day should it open on?', options: ['Today', 'The last day booked'] },
      { question: 'And should the floor plan show first?\n\nAnswer one at a time if that is easier.', options: ['Yes', 'No, the list'] },
    ])
    const body = appendEntry('Notes.', 'claude-asks', one, '2026-10-14')
    expect(questions(body).filter((q) => q.open)).toHaveLength(2)
  })

  it('answers one question at a time by quoting it, in any order', async () => {
    const { appendAnswer, questions } = await import('../src/shared/thread.js')
    const [first, second] = questions(two)
    const once = appendAnswer(two, second, 'Admins', '2026-10-14')
    expect(once).toContain('> Who sees it?\n\nAdmins')
    let qs = questions(once)
    expect(qs.map((q) => q.open)).toEqual([true, false])
    expect(qs[1].answer).toBe('Admins')
    // The last open one is quoted too: without a quote it would be a remark.
    const both = appendAnswer(once, first, 'Community', '2026-10-14')
    expect(both.trimEnd().endsWith('**You** · 2026-10-14\n> Which screen is this about?\n\nCommunity')).toBe(true)
    qs = questions(both)
    expect(qs.map((q) => [q.open, q.answer])).toEqual([[false, 'Community'], [false, 'Admins']])
    expect(openQuestions(both)).toBe(0)
  })

  it('reads a reply without a quote as a remark that answers nothing', async () => {
    const { questions } = await import('../src/shared/thread.js')
    const remark = appendEntry(two, 'you', 'Something else I noticed: the list is slow.', '2026-11-06')
    expect(openQuestions(remark)).toBe(2)
    expect(questions(remark).map((q) => q.answer)).toEqual([undefined, undefined])
    // Answering after the remark still works, one question at a time.
    const [first] = questions(remark)
    const { appendAnswer } = await import('../src/shared/thread.js')
    expect(openQuestions(appendAnswer(remark, first, 'Community', '2026-11-06'))).toBe(1)
  })

  it('reads a remark the same in a thread with one open question', () => {
    const one = appendEntry('Notes.', 'claude-asks', 'Which screen?\n\nOptions:\n- A\n- B', '2026-11-06')
    expect(openQuestions(appendEntry(one, 'you', 'Unrelated: rename the card.', '2026-11-06'))).toBe(1)
  })

  it('keeps answers written before remarks existed, so old questions stay answered', () => {
    expect(openQuestions(appendEntry(two, 'you', 'Community, and only admins.', '2026-10-14'))).toBe(0)
  })

  it('leaves a question open when the quote names no open question', () => {
    expect(openQuestions(appendEntry(two, 'you', '> Something never asked\n\nYes', '2026-11-06'))).toBe(2)
  })

  it('a plain Claude entry still closes what came before', () => {
    expect(openQuestions(appendEntry(two, 'claude', 'Moving on.', '2026-11-05'))).toBe(0)
  })
})

describe('answers from options', () => {
  it('joins the picks in the order given, and the words after them', async () => {
    const { answerText, questions, appendAnswer } = await import('../src/shared/thread.js')
    const opts = ['Today', 'The last day booked', 'Tomorrow']
    expect(answerText(opts, ['Today'], '')).toBe('Today')
    expect(answerText(opts, ['Tomorrow', 'Today'], '')).toBe('- Today\n- Tomorrow')
    expect(answerText(opts, ['Today', 'Tomorrow'], ' Whichever is later. ')).toBe('- Today\n- Tomorrow\n\nWhichever is later.')
    expect(answerText(opts, [], 'Neither')).toBe('Neither')
    // A list answer still reads as the answer to that question only.
    const body = appendEntry(appendEntry('N', 'claude-asks', 'Which day?\n\nOptions:\n- Today\n- Tomorrow', '2026-11-05'), 'claude-asks', 'Who?', '2026-11-05')
    const [q] = questions(body)
    const after = questions(appendAnswer(body, q, answerText(['Today', 'Tomorrow'], ['Today', 'Tomorrow'], 'Both work.'), '2026-11-05'))
    expect(after.map((x) => [x.open, x.answer])).toEqual([[false, '- Today\n- Tomorrow\n\nBoth work.'], [true, undefined]])
  })
})
