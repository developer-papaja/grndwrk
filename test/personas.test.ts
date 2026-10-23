import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPersona, deletePersona, listPersonas, parsePersona, settleAudienceName, updatePersona } from '../src/store/personas.js'
import { createSegment, deleteSegment, listSegments, updateSegment } from '../src/store/segments.js'
import { listScreens } from '../src/store/screens.js'
import { inBand, isGuess, looseNames, personaNamed, readEvidence, readSections, screensForPersona, sizeLabel, themeCounts, writeSections } from '../src/shared/personas.js'
import { appendEntry } from '../src/shared/thread.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
  await mkdir(join(root, 'personas'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const manager = `---
id: pe_office
name: Office administrator
summary: Owns the office, and the product with it.
tier: primary
technical: low
themes: [hardware, login]
segments:
  sg_audit: {how: most, titles: [Reception, Office manager]}
source: inferred
seen_in: [research/interviews.md]
created: 2026-10-20
---
# Office administrator

## Who they are
- **Judged on:** the office running smoothly.

## Jobs
1. Add new hires and remove leavers.

## Where it goes wrong
- An admin that needs re-learning after a holiday.

## Open questions
- Which role in the code is this?

## Thread

**Claude asks** · 2026-10-20
How many customers have a dedicated office manager?
`

const audit = { id: 'sg_audit', name: 'Clinic chains', type: 'own office', industry: 'Audit', size_min: 1000, size_max: 5000, admins: [], source: '', created: '', body: '' }
const cowork = { ...audit, id: 'sg_cowork', name: 'Coworking', type: 'coworking', size_min: 2, size_max: 10 }
const banks = { ...audit, id: 'sg_banks', name: 'Bank and finance', size_min: 90, size_max: 0 }

describe('personas', () => {
  it('reads the fields and sections, keeping older headings and a title as notes', () => {
    const p = parsePersona('pe_office', manager)
    expect(p).toMatchObject({ name: 'Office administrator', tier: 'primary', technical: 'low', themes: ['hardware', 'login'], employer: [], source: 'inferred', confirmed: '', edited: [] })
    expect(p.segments).toEqual({ sg_audit: { how: 'most', titles: ['Reception', 'Office manager'] } })
    expect(p.jobs).toBe('1. Add new hires and remove leavers.')
    expect(p.goes_wrong).toBe('- An admin that needs re-learning after a holiday.')
    expect(readSections(p.body.split('## Thread')[0]).rest).toBe('# Office administrator\n\n## Who they are\n- **Judged on:** the office running smoothly.\n\n## Open questions\n- Which role in the code is this?')
    expect(isGuess(p)).toBe(true)
  })

  it('reads older headings like What they want, and writes the sections in order with other notes where they were', () => {
    const old = readSections('## What they want\nBook fast.\n\n## What gets in the way\nQueues.\n')
    expect(old).toMatchObject({ jobs: 'Book fast.', goes_wrong: 'Queues.' })
    const notes = writeSections('# Visitor\n\n## Jobs\nFind the room.\n\n## Open questions\n- Who invites them?\n', { judged_on: 'Never late.' })
    expect(notes).toBe('# Visitor\n\n## Jobs\nFind the room.\n\n## Judged on\nNever late.\n\n## Open questions\n- Who invites them?\n')
  })

  it('marks what the person changed as theirs, writing lists, choices and segments on their own lines', async () => {
    const path = join(root, 'personas', 'pe_office.md')
    await writeFile(path, manager)
    const p = await updatePersona(root, 'pe_office', {
      summary: 'Runs the office.',
      frequency: 'daily',
      employer: ['customer', 'service provider'],
      themes: ['hardware', 'login'],
      segments: { sg_audit: { how: 'most', titles: ['Reception', 'Office manager'] }, sg_banks: { how: 'common', titles: ['Workplace team, HR'] } },
      judged_on: 'Nobody complaining.',
    })
    expect(p).toMatchObject({ summary: 'Runs the office.', frequency: 'daily', employer: ['customer', 'service provider'], judged_on: 'Nobody complaining.' })
    expect(p?.segments.sg_banks).toEqual({ how: 'common', titles: ['Workplace team, HR'] })
    expect(p?.edited).toEqual(['summary', 'frequency', 'employer', 'segments', 'judged_on'])
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('segments:\n  sg_audit: {how: most, titles: [Reception, Office manager]}\n  sg_banks: {how: common, titles: ["Workplace team, HR"]}\nsource: inferred')
    expect(raw).toContain('employer: [customer, service provider]')
    expect(raw).toContain('## Where it goes wrong\n- An admin that needs re-learning after a holiday.\n\n## Open questions\n- Which role in the code is this?\n\n## Thread\n')
    const same = await updatePersona(root, 'pe_office', { themes: ['hardware', 'login'], segments: p!.segments })
    expect(await readFile(path, 'utf8')).toBe(raw)
    expect(same?.edited).toEqual(p?.edited)
  })

  it('reads evidence tagged with a segment and themes, and counts it per theme', () => {
    const ev = readEvidence('- [Clinic chains · hardware] Appointment says Conflict.\n- [sg_cowork, login, scope] QR login fails.\n- Untagged line\nnot a line', [audit, cowork])
    expect(ev).toEqual([
      { segment: 'sg_audit', themes: ['hardware'], text: 'Appointment says Conflict.' },
      { segment: 'sg_cowork', themes: ['login', 'scope'], text: 'QR login fails.' },
      { segment: '', themes: [], text: 'Untagged line' },
    ])
    const p = { ...parsePersona('pe_office', manager), evidence: '- [Clinic chains · hardware] A\n- [Coworking · login] B\n- [Coworking · login] C' }
    expect(Object.fromEntries(themeCounts(p, [audit, cowork], null))).toEqual({ hardware: 1, login: 2 })
    expect(Object.fromEntries(themeCounts(p, [audit, cowork], new Set(['sg_audit'])))).toEqual({ hardware: 1, login: 0 })
  })

  it('reads a crafted evidence line quickly, trailing spaces and all', () => {
    const line = '- x' + ' '.repeat(60_000) + 'y' + ' '.repeat(60_000)
    const start = Date.now()
    expect(readEvidence(line, [])[0].text.startsWith('x')).toBe(true)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('keeps only segment ids and known values in segments, and never writes a crafted one back', async () => {
    const path = join(root, 'personas', 'pe_office.md')
    const crafted = manager.replace('  sg_audit: {how: most, titles: [Reception, Office manager]}', '  sg_audit: {how: "a}", titles: [X]}\n  __proto__: {how: most}\n  constructor: {how: most}')
    await writeFile(path, crafted)
    const p = parsePersona('pe_office', crafted)
    expect(Object.keys(p.segments)).toEqual(['sg_audit'])
    expect(p.segments.sg_audit.how).toBe('')
    const next = await updatePersona(root, 'pe_office', { segments: { sg_audit: { how: 'a}', titles: ['X'] }, sg_banks: { how: 'common', titles: [] } } })
    expect(next?.error).toBeUndefined()
    expect(await readFile(path, 'utf8')).toContain('segments:\n  sg_audit: {how: present, titles: [X]}\n  sg_banks: {how: common, titles: []}\n')
  })

  it('replaces a segments block whole, blank lines between its rows included', async () => {
    const path = join(root, 'personas', 'pe_office.md')
    await writeFile(path, manager.replace('  sg_audit: {how: most, titles: [Reception, Office manager]}', '  sg_audit: {how: most, titles: [A]}\n\n  sg_banks: {how: common, titles: [B]}'))
    const p = await updatePersona(root, 'pe_office', { segments: { sg_cowork: { how: 'present', titles: [] } } })
    expect(Object.keys(p!.segments)).toEqual(['sg_cowork'])
  })

  it('puts segments in size bands, open upwards when there is no top', () => {
    expect(inBand(audit, '1 000 to 10 000')).toBe(true)
    expect(inBand(audit, '50 to 250')).toBe(false)
    expect(inBand(banks, 'Over 10 000')).toBe(true)
    expect(inBand({ ...audit, size_min: 0, size_max: 0 }, 'Under 50')).toBe(false)
    expect([sizeLabel(audit), sizeLabel(banks), sizeLabel({ ...audit, size_min: 0, size_max: 0 })]).toEqual(['1\u00a0000 to 5\u00a0000', '90+', ''])
  })

  it('finds names on screens that are no persona, and settles each everywhere at once', async () => {
    await writeFile(join(root, 'personas', 'pe_office.md'), manager)
    await mkdir(join(root, 'screens'))
    await writeFile(join(root, 'screens', 'p_users.md'), '---\nid: p_users\ntitle: Users\nfor: [office administrator, managers, IT]\nstatus: built\n---\n')
    await writeFile(join(root, 'screens', 'p_home.md'), '---\nid: p_home\ntitle: Home\nfor: [Managers, visitors]\nstatus: built\n---\n')
    const loose = looseNames(await listScreens(root), await listPersonas(root))
    expect(loose.map((l) => [l.name, l.screens.length])).toEqual([['Managers', 2], ['IT', 1], ['visitors', 1]])
    await settleAudienceName(root, 'managers', { persona: 'pe_office' })
    await settleAudienceName(root, 'IT', 'remove')
    const made = await settleAudienceName(root, 'visitors', 'new')
    expect(made?.name).toBe('visitors')
    const screens = await listScreens(root)
    expect(screens.find((s) => s.id === 'p_users')?.audience).toEqual(['office administrator'])
    expect(screens.find((s) => s.id === 'p_home')?.audience).toEqual(['Office administrator', 'visitors'])
    expect(looseNames(screens, await listPersonas(root))).toEqual([])
  })

  it('confirms a guess with a date, and takes it back, without marking a field as edited', async () => {
    await writeFile(join(root, 'personas', 'pe_office.md'), manager)
    const p = await updatePersona(root, 'pe_office', { confirmed: true })
    expect(p?.confirmed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isGuess(p!)).toBe(false)
    expect(p?.edited).toEqual([])
    expect((await updatePersona(root, 'pe_office', { confirmed: false }))?.confirmed).toBe('')
  })

  it('answers in the thread with an entry file of its own, leaving the file as it was', async () => {
    const path = join(root, 'personas', 'pe_office.md')
    await writeFile(path, manager)
    const before = (await listPersonas(root))[0]
    const p = await updatePersona(root, 'pe_office', { body: appendEntry(before.body, 'you', 'About half.', '2026-10-21') })
    expect(p?.body).toContain('About half.')
    expect(await readFile(path, 'utf8')).toBe(manager)
  })

  it('carries a new name into the screens that named the old one', async () => {
    await writeFile(join(root, 'personas', 'pe_office.md'), manager)
    await mkdir(join(root, 'screens'))
    await writeFile(join(root, 'screens', 'p_users.md'), '---\nid: p_users\ntitle: Users\nfor: [office administrator, IT administrator]\nstatus: built\n---\n')
    await updatePersona(root, 'pe_office', { name: 'Office manager' })
    const [users] = await listScreens(root)
    expect(users.audience).toEqual(['Office manager', 'IT administrator'])
    const [p] = await listPersonas(root)
    expect(screensForPersona(p, [users]).map((s) => s.id)).toEqual(['p_users'])
    expect(personaNamed('OFFICE MANAGER', [p])?.id).toBe('pe_office')
  })

  it('creates a persona from a name, refuses a name taken, and deletes it with its thread', async () => {
    const p = await createPersona(root, { name: '  Visitor ' })
    expect(p).toMatchObject({ name: 'Visitor', edited: ['name'], source: '' })
    expect(isGuess(p)).toBe(false)
    expect(p.id).toMatch(/^pe_[a-z0-9]{6}$/)
    await expect(createPersona(root, { name: 'visitor' })).rejects.toThrow('already a persona called Visitor')
    expect(await deletePersona(root, p.id)).toBe(true)
    expect(await listPersonas(root)).toEqual([])
  })

  it('shows a file that cannot be read, with why', async () => {
    await writeFile(join(root, 'personas', 'pe_bad.md'), 'just text')
    await writeFile(join(root, 'personas', 'notes.md'), '---\nname: x\n---\n')
    const list = await listPersonas(root)
    expect(list.map((p) => [p.id, !!p.error])).toEqual([['notes', true], ['pe_bad', true]])
  })
})

describe('segments', () => {
  it('creates a segment, edits only the lines that change, and deletes it', async () => {
    const sg = await createSegment(root, { name: 'Clinic chains' })
    expect(sg.id).toMatch(/^sg_[a-z0-9]{6}$/)
    await expect(createSegment(root, { name: 'clinic chains' })).rejects.toThrow('already a segment')
    const next = await updateSegment(root, sg.id, { type: 'own office', size_min: 1000, size_max: 5000, admins: ['Reception', 'Service desk'] })
    expect(next).toMatchObject({ type: 'own office', size_min: 1000, size_max: 5000, admins: ['Reception', 'Service desk'] })
    const raw = await readFile(join(root, 'segments', `${sg.id}.md`), 'utf8')
    expect(raw).toContain('size_min: 1000\nsize_max: 5000\nadmins: [Reception, Service desk]')
    expect((await updateSegment(root, sg.id, { size_max: 0 }))?.size_max).toBe(0)
    expect(await deleteSegment(root, sg.id)).toBe(true)
    expect(await listSegments(root)).toEqual([])
  })
})
