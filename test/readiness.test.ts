import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markAnswered, parseDesign, parseFocus, parseGaps, readReadiness, setFocusLater } from '../src/store/readiness.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
  await mkdir(join(root, 'readiness'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('readiness', () => {
  it('reads nothing gracefully before the first run', async () => {
    expect(await readReadiness(root)).toEqual({ report: null, gaps: [], design: [], foundations: [], focus: [] })
  })

  it('reads the verdict and checked date from the report', async () => {
    await writeFile(join(root, 'readiness', 'report.md'), '---\nverdict: Not ready\nchecked: 2026-10-03\n---\nBody\n')
    const r = await readReadiness(root)
    expect(r.report).toEqual({ verdict: 'not ready', checked: '2026-10-03', body: 'Body\n', closed: [], added: [] })
  })

  it('keeps usable gaps, fills defaults and drops broken ones', () => {
    const gaps = parseGaps(JSON.stringify([
      { id: 'gap_a', title: 'No typography', severity: 'blocking', near: ['n_1', 2], altitude: 9, topic: ' look ' },
      { title: 'No id here' },
      { id: 'gap_a', title: 'Duplicate id' },
      { id: 'x', severity: 'blocking' },
      'nonsense',
    ]))
    expect(gaps).toEqual([
      { id: 'gap_a', area: '', title: 'No typography', why: '', near: ['n_1'], severity: 'blocking', topic: 'look', altitude: 5 },
      { id: 'gap_2', area: '', title: 'No id here', why: '', near: [], severity: 'important' },
    ])
  })

  it('reads the design scorecard in the fixed order and keeps only known items', () => {
    const design = parseDesign(JSON.stringify([
      { item: 'Typography', status: 'partly', note: 'One font, no scale', seen_in: ['ui/src/style.css'] },
      { item: 'colors as tokens', status: 'found', note: 'In @theme' },
      { item: 'mood board', status: 'found' },
      { item: 'icons', status: 'great' },
    ]))
    expect(design.map((d) => [d.item, d.status])).toEqual([['colors as tokens', 'found'], ['typography', 'partly'], ['icons', 'missing']])
    expect(design[1].seen_in).toEqual(['ui/src/style.css'])
  })

  it('keeps a scorecard per platform when a repo holds more than one app', () => {
    const design = parseDesign(JSON.stringify([
      { platform: 'All', item: 'shared across platforms', status: 'partly' },
      { platform: 'Android', item: 'typography', status: 'missing' },
      { platform: 'iOS', item: 'typography', status: 'found' },
      { platform: 'iOS', item: 'colors as tokens', status: 'found' },
      { platform: 'iOS', item: 'colors as tokens', status: 'missing' },
    ]))
    expect(design.map((d) => `${d.platform} ${d.item} ${d.status}`)).toEqual([
      'Android typography missing',
      'iOS colors as tokens found',
      'iOS typography found',
      'All shared across platforms partly',
    ])
  })

  it('reports a broken gaps file instead of throwing', async () => {
    await writeFile(join(root, 'readiness', 'gaps.json'), '{ not json')
    const r = await readReadiness(root)
    expect(r.gaps).toEqual([])
    expect(r.error).toMatch(/gaps.json could not be read/)
  })

  it('marks one gap answered and keeps everything else as written', async () => {
    const file = join(root, 'readiness', 'gaps.json')
    await writeFile(file, JSON.stringify([{ id: 'gap_a', title: 'A', extra: 'kept' }, { id: 'gap_b', title: 'B' }]))
    expect(await markAnswered(root, 'gap_b', 'n_x7a2')).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ id: 'gap_a', title: 'A', extra: 'kept' }, { id: 'gap_b', title: 'B', answered_by: 'n_x7a2' }])
    expect(await markAnswered(root, 'gap_zz', 'n_1')).toBe(false)
  })

  it('marks a gap as enough for now, and keeps suggestions', async () => {
    const file = join(root, 'readiness', 'gaps.json')
    const suggestions = [{ title: 'Use the sizes in style.css', why: 'They are already in use' }, { title: '' }, 'junk']
    await writeFile(file, JSON.stringify([{ id: 'gap_a', title: 'A', suggestions }]))
    expect(await markAnswered(root, 'gap_a', 'n_x7a2', true)).toBe(true)
    const [gap] = (await readReadiness(root)).gaps
    expect(gap.enough).toBe(true)
    expect(gap.answered_by).toBe('n_x7a2')
    expect(gap.suggestions).toEqual([{ title: 'Use the sizes in style.css', why: 'They are already in use' }])
    // Answering again without enough reopens it for /readiness to check.
    await markAnswered(root, 'gap_a', 'n_b', false)
    expect((await readReadiness(root)).gaps[0].enough).toBeUndefined()
  })

  it('ignores enough on a gap nobody answered', () => {
    expect(parseGaps(JSON.stringify([{ id: 'gap_a', title: 'A', enough: true }]))[0].enough).toBeUndefined()
  })

  it('reads what closed and what was added since the last check', async () => {
    await writeFile(join(root, 'readiness', 'report.md'), '---\nverdict: ready to build\nchecked: 2026-10-08\nclosed: ["Type scale and spacing", "Lint, and format"]\nadded: ["Spacing scale"]\n---\nBody\n')
    const { report } = await readReadiness(root)
    expect(report?.closed).toEqual(['Type scale and spacing', 'Lint, and format'])
    expect(report?.added).toEqual(['Spacing scale'])
  })
})

describe('focus', () => {
  it('reads the newest focus list, most important first, and drops broken items', () => {
    const { checked, items } = parseFocus(JSON.stringify({
      checked: '2026-11-05',
      items: [
        { id: 'design_system', title: 'Your design system is not complete', why: 'Every screen invents its own spacing.', prompt: 'Write DESIGN.md' },
        { id: 'design_system', title: 'Duplicate' },
        { id: 'Bad Id', title: 'Bad id' },
        { id: 'tests', title: '' },
        { id: 'tests', title: 'No tests', why: 3 },
      ],
    }))
    expect(checked).toBe('2026-11-05')
    expect(items).toEqual([
      { id: 'design_system', title: 'Your design system is not complete', why: 'Every screen invents its own spacing.', prompt: 'Write DESIGN.md' },
      { id: 'tests', title: 'No tests', why: '', prompt: '' },
    ])
    expect(parseFocus('[{"id":"a","title":"A"}]').items).toHaveLength(1)
  })

  it('keeps Not now in a file of its own, across runs, until it is taken back', async () => {
    await mkdir(join(root, 'readiness', 'focus'))
    await writeFile(join(root, 'readiness', 'focus', '1793876000000-ab.json'), JSON.stringify({ checked: '2026-11-05', items: [{ id: 'tests', title: 'No tests' }, { id: 'a11y', title: 'Accessibility' }] }))
    await setFocusLater(root, 'tests', true)
    let r = await readReadiness(root)
    expect(r.focusChecked).toBe('2026-11-05')
    expect(r.focus.map((f) => [f.id, !!f.later])).toEqual([['tests', true], ['a11y', false]])
    // A newer run still lists it: it stays set aside.
    await writeFile(join(root, 'readiness', 'focus', '1793877000000-cd.json'), JSON.stringify({ items: [{ id: 'tests', title: 'Still no tests' }] }))
    r = await readReadiness(root)
    expect(r.focus.map((f) => [f.title, !!f.later])).toEqual([['Still no tests', true]])
    await setFocusLater(root, 'tests', false)
    expect((await readReadiness(root)).focus[0].later).toBeUndefined()
    await expect(setFocusLater(root, '../x', true)).rejects.toThrow()
  })
})
