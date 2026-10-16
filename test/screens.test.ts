import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listScreens, parseScreen, updateScreen } from '../src/store/screens.js'
import { commentsForScreen, layoutSitemap, screenTree, storiesForScreen } from '../src/shared/screens.js'
import type { GNode, Screen, Story } from '../src/shared/types.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
  await mkdir(join(root, 'screens'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const booking = `---
id: p_book
title: Booking
parent: p_home
purpose: Book a desk for one day.
for: [someone arriving at the office]
does:
  - pick a day
  - confirm the booking
leads_to: [p_conf, p_book]
code: [/booking, App/Booking/BookingView.swift]
stories: [s_k3f9]
status: built
source: code
created: 2026-10-12
reviewed: yes
---
On the screen: a calendar and a floor plan.
`

const screen = (id: string, title: string, parent = '', extra: Partial<Screen> = {}): Screen => ({
  id, title, parent, purpose: '', audience: [], tasks: [], leads_to: [], code: [], open: [], seen_as: [], shots: [], in: [], replaced_by: '', stories: [], status: 'built', source: '', created: '', body: '', ...extra,
})

describe('screens store', () => {
  it('reads a screen, with purpose, who it is for and what they do', async () => {
    await writeFile(join(root, 'screens', 'p_book.md'), booking)
    await writeFile(join(root, 'screens', 'notes.md'), 'not a screen')
    const [stray, s] = await listScreens(root)
    // A file that is not a screen shows, saying why, rather than vanishing.
    expect(stray.error).toMatch(/must be p_/)
    expect(s).toMatchObject({ id: 'p_book', title: 'Booking', parent: 'p_home', audience: ['someone arriving at the office'], tasks: ['pick a day', 'confirm the booking'], leads_to: ['p_conf'], status: 'built' })
  })

  it('falls back on a status it does not know, and reports a broken file', () => {
    expect(parseScreen('p_x', '---\ntitle: X\nstatus: shipped\n---\n').status).toBe('built')
    expect(parseScreen('p_x', '---\ntitle: [\n---\n').error).toBeTruthy()
  })

  it('changes only the words and keeps the rest, including keys it does not know', async () => {
    const path = join(root, 'screens', 'p_book.md')
    await writeFile(path, booking)
    const s = await updateScreen(root, 'p_book', { purpose: 'Book a desk, fast', audience: ['visitors, now and then', 'staff'], tasks: ['pick a desk'] })
    expect(s).toMatchObject({ purpose: 'Book a desk, fast', audience: ['visitors, now and then', 'staff'], tasks: ['pick a desk'], code: ['/booking', 'App/Booking/BookingView.swift'], stories: ['s_k3f9'] })
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('reviewed: "yes"')
    expect(raw).toContain('On the screen: a calendar and a floor plan.')
    expect(await updateScreen(root, 'p_none', { purpose: 'x' })).toBeNull()
  })
})

describe('screen tree and links', () => {
  it('puts children under their parent, and survives a missing parent or a loop', () => {
    const rows = screenTree([screen('p_b', 'Booking', 'p_h'), screen('p_h', 'Home'), screen('p_s', 'Settings', 'p_gone'), screen('p_x', 'X', 'p_y'), screen('p_y', 'Y', 'p_x')])
    expect(rows.map((r) => `${r.depth}${r.screen.title}`)).toEqual(['0Home', '1Booking', '0Settings', '0X', '0Y'])
  })

  it('finds stories by id or by the code they apply to, but not by a generic file name', () => {
    const s = screen('p_b', 'Booking', '', { code: ['App/Booking/BookingView.swift', 'app/booking/page.tsx'], stories: ['s_1'] })
    const story = (id: string, applies_to: string[]) => ({ id, applies_to }) as Story
    expect(storiesForScreen(s, [story('s_1', []), story('s_2', ['Sources/BookingView.swift']), story('s_3', ['app/home/page.tsx'])]).map((x) => x.id)).toEqual(['s_1', 's_2'])
  })

  it('finds comments made on the screen, by topic or where they were seen', () => {
    const s = screen('p_b', 'Booking', '', { code: ['App/Booking/BookingView.swift'] })
    const node = (id: string, topic: string, source: string, seen_in: string[] = []) => ({ id, topic, extra: { source, seen_in } }) as unknown as GNode
    const found = commentsForScreen(s, [node('a', 'booking', 'app'), node('b', 'Home', 'app', ['Home', 'BookingView']), node('c', 'booking', 'code')])
    expect(found.map((n) => n.id)).toEqual(['a', 'b'])
  })
})

describe('sitemap layout', () => {
  it('puts the product on top, children under their parent, and a parent over its children', () => {
    const l = layoutSitemap([screen('p_h', 'Home'), screen('p_a', 'A', 'p_h'), screen('p_b', 'B', 'p_h'), screen('p_s', 'Settings')])
    const at = (id: string) => l.boxes.find((b) => b.id === id)!
    expect([at('').depth, at('p_h').depth, at('p_a').depth, at('p_s').depth]).toEqual([0, 1, 2, 1])
    expect(at('p_h').x).toBe((at('p_a').x + at('p_b').x) / 2)
    expect(at('p_a').x).toBeLessThan(at('p_b').x)
    expect(at('p_b').x).toBeLessThan(at('p_s').x)
    expect(l.edges).toContainEqual({ from: 'p_h', to: 'p_a' })
    expect(l.edges).toContainEqual({ from: '', to: 'p_s' })
  })
})
