import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/shared-store/memory.js'
import { storeHandler } from '../src/shared-store/http.js'
import { searchThoughts } from '../src/shared/overview.js'

// The page's build points the store code's file calls at the in-memory map; so does this test.
vi.mock('../src/store/fs.js', async () => await import('../ui/src/page/vfs.js'))

const api = await import('../ui/src/api-store.js')

const PORT = 18134
const root = `http://127.0.0.1:${PORT}/`
const words = new TextEncoder()

/** sessionStorage, for this test: tokens per project, as the page keeps them. */
class TabStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

const node = (id: string, title: string, more = '', body = '') => [`nodes/${id}.md`, `---\nid: ${id}\ntype: idea\ntitle: ${title}\naltitude: 3\nlinks: []\nstatus: open\ncreated: 2026-11-01\n${more}---\n${body}`]
const asks = (owner: string, run: string, question: string) => [`threads/${owner}/${run}.md`, `---\nwho: claude-asks\ndate: 2026-11-02\n---\n${question}\n`]
const story = (id: string, status: string, more = '') => [`stories/${id}.md`, `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\nfrom: [n_book01]\napplies_to: []\ncreated: 2026-11-01\n${more}---\nAs a vet, I want this.\n`]

/** The front desk app: questions, gaps, a focus list, stories, and fixes to test. */
const CLINIC = Object.fromEntries([
  ['project.md', '---\nname: Clinic app\n---\n'],
  node('n_book01', 'Booking should feel like texting', '', 'Owners book a visit the way they text a friend.\n'),
  asks('n_book01', '1794850638334-xl', 'Should a visit be booked in one step?'),
  asks('n_book01', '1794850638335-xm', 'Can owners book for two pets at once?'),
  node('n_remi01', 'Reminders by text the day before', 'built: 2026-11-10\n'),
  // A guess from /survey with no question: one thing to confirm.
  node('n_gues01', 'Vets work in shifts', 'source: inferred\n'),
  node('n_done01', 'Weight in kilograms', '', 'Settled long ago.\n').map((x, i) => (i ? x.replace('status: open', 'status: settled') : x)),
  ['screens/p_cal001.md', '---\nid: p_cal001\ntitle: Calendar\npurpose: The day at a glance.\nstatus: built\ncreated: 2026-11-01\n---\n'],
  asks('p_cal001', '1794850638336-xn', 'Who opens the calendar first in the morning?'),
  ['readiness/gaps/gap_rooms.json', JSON.stringify({ id: 'gap_rooms', area: 'flows', title: 'No plan for rooms', why: 'Two vets in one room', severity: 'blocking' })],
  ['readiness/gaps/gap_types.json', JSON.stringify({ id: 'gap_types', area: 'design', title: 'No typography', why: 'Every screen invents one', severity: 'blocking', answered_by: 'n_book01' })],
  ['readiness/gaps/gap_nice.json', JSON.stringify({ id: 'gap_nice', area: 'design', title: 'No dark mode', why: 'Night shifts', severity: 'nice' })],
  ['readiness/focus/1794850000000-ab.json', JSON.stringify({ checked: '2026-11-12', items: [{ id: 'tests', title: 'Write the first tests', why: 'Nothing checks booking yet', prompt: 'Add tests' }, { id: 'tokens', title: 'Pick design tokens', why: 'Colors drift', prompt: 'Pick tokens' }] })],
  ['readiness/focus-later/tests.json', JSON.stringify({ later: '2026-11-13' })],
  story('s_one001', 'done'),
  story('s_two001', 'partial'),
  story('s_thr001', 'not-started'),
  story('s_fou001', 'partial', 'later: 2026-11-14\n'),
])

/** The admin dashboard: nothing waits there but one question. */
const ADMIN = Object.fromEntries([
  ['project.md', '---\nname: Clinic admin\n---\n'],
  node('n_bill01', 'Invoices per clinic', '', 'Each clinic in a chain gets its own invoice.\n'),
  asks('n_bill01', '1794850638337-xo', 'Monthly or per visit?'),
])

describe('All projects, on the page on a store', () => {
  const clinic = new MemoryStore('Clinic app')
  const admin = new MemoryStore('Clinic admin')
  const stores: Record<string, MemoryStore> = { clinic, 'clinic-admin': admin }
  // One token for both projects, as a store with one login hands out; another only for the admin dashboard.
  const tokens: Record<string, string[]> = { 'gwt-both': ['clinic', 'clinic-admin'], 'gwt-admin': ['clinic-admin'] }
  let server: Server
  let sub: { close(): void } | null = null
  const storage = new TabStorage()
  /** Every token that reached a path, to check none goes where it should not. */
  const sent: { path: string; token: string }[] = []

  beforeAll(async () => {
    for (const [mem, files] of [[clinic, CLINIC], [admin, ADMIN]] as const) {
      for (const [path, text] of Object.entries(files)) await mem.write(path, words.encode(text), { type: '', create: true })
    }
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', root)
      const carried = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (carried) sent.push({ path: url.pathname, token: carried })
      if (url.pathname === '/v1/projects') {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const mine = tokens[bearer]
        res.writeHead(mine ? 200 : 401, { 'Content-Type': 'application/json' })
        return void res.end(JSON.stringify(mine ? { projects: [...mine.map((n) => ({ name: n === 'clinic' ? 'Clinic app' : 'Clinic admin', url: `${root}${n}/` })), { name: 'Elsewhere', url: 'https://other.example/clinic/' }] } : { error: 'No' }))
      }
      const name = url.pathname.split('/')[1]
      if (!stores[name]) return void res.writeHead(404).end()
      void storeHandler(stores[name], (bearer) => (tokens[bearer]?.includes(name) ? 'read' : null))(req, res, `/${name}/`)
    })
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    api.configure({ base: `${root}clinic/`, storage: storage as unknown as Storage })
    expect(await api.signIn('gwt-both')).toBe('')
    // The page holds its own project's map already; the others are read when All projects opens.
    await new Promise<void>((done) => {
      sub = api.subscribe({ onEvent: () => {}, onOpen: done, onError: () => {} })
    })
  })
  afterAll(async () => {
    sub?.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('finds the projects the store lists for this sign-in, this one first, and sends this one\'s token to none of the others', async () => {
    sent.length = 0
    const list = await api.teamProjects()
    expect(list).toEqual([
      { name: 'Clinic app', url: `${root}clinic/`, current: true, signedIn: true },
      { name: 'Clinic admin', url: `${root}clinic-admin/`, current: false, signedIn: false },
    ])
    // Listed, not signed in there: reading it asks for a sign-in, and nothing went to its address.
    await expect(api.readTeamProject(`${root}clinic-admin/`)).rejects.toBeInstanceOf(api.SignInThere)
    expect(sent.filter((s) => s.path.startsWith('/clinic-admin/'))).toEqual([])
    expect(sent.every((s) => s.path === '/v1/projects' || s.path.startsWith('/clinic/'))).toBe(true)
  })

  it('takes a project\'s address only as a project root on this store', () => {
    expect(api.projectUrl(`${root}clinic-admin/`)).toBe(`${root}clinic-admin/`)
    expect(api.projectUrl('/clinic-admin/')).toBe(`${root}clinic-admin/`)
    for (const bad of [`${root}v1/`, `${root}`, `${root}clinic/v1/`, `${root}clinic/files/n_book01/`, `${root}clinic-admin`, `${root}clinic/../v1/`, `${root}%2e%2e/`, `${root}clinic-admin/?a=1`, 'https://other.example/clinic/', `http://user:pw@127.0.0.1:${PORT}/clinic/`]) {
      expect(api.projectUrl(bad), bad).toBe('')
    }
  })

  it('counts what waits in each project from its own files', async () => {
    // Signed in there with its own token, as the person does on its card.
    expect(await api.signInToProject(`${root}clinic-admin/`, 'gwt-both')).toBe('')
    sent.length = 0
    const [here, there] = await Promise.all([api.readTeamProject(`${root}clinic/`), api.readTeamProject(`${root}clinic-admin/`)])
    expect(here.name).toBe('Clinic app')
    // Two questions on a thought, one guess to confirm, one on a screen.
    expect(here.overview).toEqual({
      questions: 4,
      blocking: 1,
      focus: { title: 'Pick design tokens', why: 'Colors drift' },
      stories: { done: 1, partly: 1, all: 4 },
      toTest: 1,
    })
    expect(there.name).toBe('Clinic admin')
    expect(there.overview).toEqual({ questions: 1, blocking: 0, focus: null, stories: { done: 0, partly: 0, all: 0 }, toTest: 0 })
    // Each project's token went to that project's address only.
    expect(sent.filter((s) => s.path.startsWith('/clinic-admin/')).every((s) => s.token === storage.getItem('grndwrk.token:/clinic-admin/'))).toBe(true)
  })

  it('searches thought titles and notes across them, each hit naming its thought', async () => {
    const there = await api.readTeamProject(`${root}clinic-admin/`)
    const here = await api.readTeamProject(`${root}clinic/`)
    expect(searchThoughts(here.thoughts, 'text').map((h) => h.id)).toEqual(['n_book01', 'n_remi01'])
    expect(searchThoughts(there.thoughts, 'clinic invoice')[0]).toMatchObject({ id: 'n_bill01', title: 'Invoices per clinic' })
    expect(searchThoughts(here.thoughts, 'way they text')[0].snippet).toMatch(/the way they text a friend/)
  })

  it('reads another project with that project\'s own sign-in, and asks for one when there is none', async () => {
    // A tab signed in to another store project at its own address, which the store does not list for this token.
    const other = new MemoryStore('Kennel')
    await other.write('project.md', words.encode('---\nname: Kennel\n---\n'), { type: '', create: true })
    stores.kennel = other
    expect((await api.teamProjects()).find((p) => p.url === `${root}kennel/`)).toBeUndefined()
    storage.setItem('grndwrk.token:/kennel/', 'gwt-kennel')
    const kennel = (await api.teamProjects()).find((p) => p.url === `${root}kennel/`)
    expect(kennel).toMatchObject({ name: 'kennel', signedIn: true, current: false })
    // That token is not one the store takes there: sign in again, and the token is forgotten.
    await expect(api.readTeamProject(`${root}kennel/`)).rejects.toBeInstanceOf(api.SignInThere)
    expect(storage.getItem('grndwrk.token:/kennel/')).toBeNull()
  })

  it('keeps tokens to this store: a project the list names elsewhere is left out', async () => {
    expect((await api.teamProjects()).map((p) => p.name)).not.toContain('Elsewhere')
    expect(await api.signInToProject('https://other.example/clinic/', 'gwt-both')).toMatch(/not on this store/)
    expect(await api.signInToProject(`${root}clinic-admin/`, 'nope')).toMatch(/did not take/)
    expect(await api.signInToProject(`${root}clinic-admin/`, 'gwt-admin')).toBe('')
    expect(storage.getItem('grndwrk.token:/clinic-admin/')).toBe('gwt-admin')
  })
})
