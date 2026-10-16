import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listShots, readShot, saveIosShot, saveShot } from '../src/store/shots.js'
import { parseScreenshot } from '../src/server/comments.js'
import { needsExample, openPath, shotsForScreen } from '../src/shared/screens.js'
import { listScreens, parseScreen, placeShot } from '../src/store/screens.js'

let gw: string
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-shots-'))
})
afterEach(() => rm(gw, { recursive: true, force: true }))

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const screen = (fields: string) => parseScreen('p_book', `---\nid: p_book\ntitle: Booking\n${fields}\n---\n`)

describe('pictures of screens', () => {
  it('keeps them by name, out of git, and reads back only what is there', async () => {
    await saveShot(gw, 'ios', 'Order details', JPEG)
    await saveShot(gw, 'web', 'p_book', Buffer.from('png'))
    const shots = await listShots(gw)
    expect(shots.map((s) => [s.platform, s.key]).sort()).toEqual([['ios', 'Order details'], ['web', 'p_book']])
    expect(await readFile(join(gw, '.gitignore'), 'utf8')).toBe('shots/\n')
    expect(await readShot(gw, 'ios', 'Order%20details.jpg')).toMatchObject({ type: 'image/jpeg' })
    expect(await readShot(gw, 'ios', '../project.md')).toBeNull()
    expect(await readShot(gw, 'etc', 'passwd')).toBeNull()
  })

  it('takes only a JPEG, under the view name or the title', () => {
    const image = `data:image/jpeg;base64,${JPEG.toString('base64')}`
    expect(parseScreenshot({ screen: 'Book', component: 'BookingView', image }).about.screen).toBe('BookingView')
    expect(parseScreenshot({ screen: 'Book', image }).about.screen).toBe('Book')
    expect(() => parseScreenshot({ screen: 'Book', image: 'data:image/jpeg;base64,PGh0bWw+' })).toThrow()
    expect(() => parseScreenshot({ image })).toThrow()
  })

  it('finds a screen by its id on the web, and by code, title or seen_as on iOS', () => {
    const shots = [
      { platform: 'web', key: 'p_book' },
      { platform: 'ios', key: 'BookingView' },
      { platform: 'ios', key: 'Book' },
      { platform: 'ios', key: 'Settings' },
    ]
    const keys = (s: ReturnType<typeof screen>) => shotsForScreen(s, shots).map((x) => x.key)
    expect(keys(screen('code: [App/BookingView.swift]'))).toEqual(['p_book', 'BookingView'])
    expect(keys(screen('code: []\nseen_as: [Book]'))).toEqual(['p_book', 'Book'])
  })

  it('keeps a picture per screen that looks different when they share a fallback name', async () => {
    const home = { screen: 'App', named: false, texts: ['Good morning', 'Your desk today', 'Desk 12', 'Book again'], ids: [] }
    const planner = { screen: 'App', named: false, texts: ['Planner', 'Monday', 'Tuesday', 'Floor 3'], ids: ['planner-grid'] }
    expect(await saveIosShot(gw, home, JPEG)).toBe('App')
    expect(await saveIosShot(gw, planner, JPEG)).toBe('App-2')
    // Home again, with another desk number: the same screen, the same file.
    expect(await saveIosShot(gw, { ...home, texts: ['Good morning', 'Your desk today', 'Desk 7', 'Book again'] }, JPEG)).toBe('App')
    expect(await saveIosShot(gw, planner, JPEG)).toBe('App-2')
    const shots = await listShots(gw)
    expect(shots.map((s) => s.file).sort()).toEqual(['ios/App-2.jpg', 'ios/App.jpg'])
    expect(shots.find((s) => s.key === 'App-2')?.texts).toContain('planner-grid')
    expect(JSON.parse(await readFile(join(gw, 'shots/ios/App-2.json'), 'utf8')).texts).toContain('Floor 3')
    // A screen with a name of its own keeps one file, however it looks.
    const book = { screen: 'Book', named: true, texts: ['Pick a day'], ids: [] }
    expect(await saveIosShot(gw, book, JPEG)).toBe('Book')
    expect(await saveIosShot(gw, { ...book, texts: ['Something else'] }, JPEG)).toBe('Book')
  })

  it('gives a picture a screen names in shots: to that screen only', () => {
    const shots = [
      { platform: 'ios', key: 'App', file: 'ios/App.jpg' },
      { platform: 'ios', key: 'App-2', file: 'ios/App-2.jpg' },
      { platform: 'ios', key: 'Book', file: 'ios/Book.jpg' },
    ]
    const home = parseScreen('p_home', '---\nid: p_home\ntitle: Home\nshots: [ios/App.jpg]\n---\n')
    const plan = parseScreen('p_plan', '---\nid: p_plan\ntitle: Planner\nshots: ["ios/App-2.jpg"]\n---\n')
    // Claims Book.jpg although its title would give it to Booking.
    const other = parseScreen('p_oth', '---\nid: p_oth\ntitle: Other\nshots: [/shots/ios/Book.jpg]\n---\n')
    const book = parseScreen('p_book', '---\nid: p_book\ntitle: Book\n---\n')
    const all = [home, plan, other, book]
    const keys = (s: typeof home) => shotsForScreen(s, shots, all).map((x) => x.key)
    expect(keys(home)).toEqual(['App'])
    expect(keys(plan)).toEqual(['App-2'])
    expect(keys(other)).toEqual(['Book'])
    expect(keys(book)).toEqual([])
  })

  it('places a picture on one screen at a time', async () => {
    await mkdir(join(gw, 'screens'), { recursive: true })
    await writeFile(join(gw, 'screens/p_home.md'), '---\nid: p_home\ntitle: Home\nshots: [ios/App-2.jpg]\nkeep_me: kept\n---\nNotes.\n')
    await writeFile(join(gw, 'screens/p_plan.md'), '---\nid: p_plan\ntitle: Planner\n---\n')
    expect(await placeShot(gw, 'ios/App-2.jpg', 'p_plan')).toBe(true)
    const byId = Object.fromEntries((await listScreens(gw)).map((s) => [s.id, s]))
    expect(byId.p_plan.shots).toEqual(['ios/App-2.jpg'])
    expect(byId.p_home.shots).toEqual([])
    expect(await readFile(join(gw, 'screens/p_home.md'), 'utf8')).toContain('keep_me: kept')
    expect(await placeShot(gw, 'ios/App-2.jpg', '')).toBe(true)
    expect((await listScreens(gw)).every((s) => !s.shots.length)).toBe(true)
    expect(await placeShot(gw, 'ios/App-2.jpg', 'p_none')).toBe(false)
  })

  it('opens a route without parameters, or the example given', () => {
    expect(openPath(screen('code: [/booking, App/BookingView.swift]'))).toBe('/booking')
    expect(openPath(screen('code: [/booking/:id]'))).toBe('')
    expect(needsExample(screen('code: [/booking/:id]'))).toBe(true)
    expect(openPath(screen('code: [/booking/:id]\nopen: [/booking/42]'))).toBe('/booking/42')
  })
})
