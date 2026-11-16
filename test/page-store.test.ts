import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pageAnswer } from '../src/shared-store/page.js'
import { expectServesPage, writeFakePage } from './page-fixture.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/shared-store/memory.js'
import { storeHandler } from '../src/shared-store/http.js'
import { appendAnswer, questions } from '../src/shared/thread.js'
import type { GNode, ServerEvent } from '../src/shared/types.js'

// The page's build points the store code's file calls at the in-memory map; so does this test.
vi.mock('../src/store/fs.js', async () => await import('../ui/src/page/vfs.js'))

const api = await import('../ui/src/api-store.js')

const PORT = 18131
const base = `http://127.0.0.1:${PORT}/clinic/`
const words = new TextEncoder()
const text = new TextDecoder()

const NODE = 'nodes/n_book01.md'
const QUESTION = 'threads/n_book01/1794850638334-xl.md'

describe('the page on a store (api-store.ts)', () => {
  const mem = new MemoryStore('Clinic')
  const roles: Record<string, 'read' | 'write'> = { 'gwt-write': 'write', 'gwt-read': 'read' }
  let server: Server
  const events: ServerEvent[] = []
  let sub: { close(): void } | null = null

  const open = () =>
    new Promise<void>((done) => {
      sub = api.subscribe({ onEvent: (e) => events.push(e), onOpen: done, onError: () => {} })
    })
  const nodeFile = async () => mem.read(NODE)

  beforeAll(async () => {
    const handle = storeHandler(mem, (bearer) => roles[bearer] ?? null)
    server = createServer((req, res) => void handle(req, res, '/clinic/'))
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await mem.write('project.md', words.encode('---\nname: Clinic\n---\n'), { type: 'text/markdown', create: true })
    await mem.write(NODE, words.encode('---\nid: n_book01\ntype: question\ntitle: Booking should feel like texting\naltitude: 4\nlinks: []\nstatus: open\ncreated: 2026-11-01\n---\nHow short can booking get?\n'), { type: 'text/markdown', create: true })
    await mem.write(QUESTION, words.encode('---\nwho: claude-asks\ndate: 2026-11-02\n---\nShould a visit be booked in one step?\n'), { type: 'text/markdown', create: true })
  })

  afterAll(async () => {
    sub?.close()
    // Long polls still waiting are cut, so the server stops at once.
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('refuses a token the store does not take, in plain words', async () => {
    api.configure({ base })
    expect(await api.signIn('nope')).toMatch(/did not take that token/)
    expect(api.session.signedIn).toBe(false)
  })

  it('reads the whole map, with its thread entries merged into the card', async () => {
    expect(await api.signIn('gwt-write')).toBe('')
    expect(api.session).toMatchObject({ signedIn: true, writable: true, project: 'Clinic' })
    await open()
    const [n] = await api.fetchNodes()
    expect(n.title).toBe('Booking should feel like texting')
    expect(questions(n.body).filter((q) => q.open).map((q) => q.question)).toEqual(['Should a visit be booked in one step?'])
    expect((await api.fetchProject()).name).toBe('Clinic')
  })

  it('answers a question as a new entry file, leaving the card file as it was', async () => {
    const card = await nodeFile()
    const [n] = await api.fetchNodes()
    const q = questions(n.body).find((x) => x.open)!
    const after = await api.updateNode(n.id, { body: appendAnswer(n.body, q, 'Yes, one step.', '2026-11-16') })
    expect(questions(after.body).filter((x) => x.open)).toEqual([])
    const all = (await mem.changes({})).changes.map((c) => c.path)
    const entries = all.filter((p) => p.startsWith('threads/n_book01/'))
    expect(entries).toHaveLength(2)
    const answer = await mem.read(entries.find((p) => p !== QUESTION)!)
    expect(text.decode(answer!.bytes)).toBe('---\nwho: you\ndate: 2026-11-16\n---\n> Should a visit be booked in one step?\n\nYes, one step.\n')
    expect((await nodeFile())!.version).toBe(card!.version)
  })

  it('stays live: a card someone else adds arrives as an event', async () => {
    events.length = 0
    await mem.write('nodes/n_vets01.md', words.encode('---\nid: n_vets01\ntitle: Vets see the day at a glance\n---\n'), { type: 'text/markdown', create: true })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'node:upsert' && e.node.id === 'n_vets01')).toBe(true), { timeout: 5000 })
  })

  it('adds a thought as a new node file', async () => {
    const n: GNode = await api.createNode({ title: 'Reminders by text the day before' })
    expect(n.id).toMatch(/^n_[a-z0-9]{6}$/)
    expect(text.decode((await mem.read(`nodes/${n.id}.md`))!.bytes)).toMatch(/title: Reminders by text the day before/)
  })

  it('says plainly when someone changed a card meanwhile, and shows their version', async () => {
    sub?.close()
    sub = null
    const there = (await nodeFile())!
    const theirs = text.decode(there.bytes).replace('title: Booking should feel like texting', 'title: Booking in one step')
    await mem.write(NODE, words.encode(theirs), { type: 'text/markdown', ifVersion: there.version })
    await expect(api.updateNode('n_book01', { title: 'Booking like a text message' })).rejects.toThrow(/Someone changed this thought meanwhile/)
    expect((await api.fetchNodes()).find((n) => n.id === 'n_book01')!.title).toBe('Booking in one step')
    expect(text.decode((await nodeFile())!.bytes)).toMatch(/title: Booking in one step/)
  })

  it('a read token reads, and cannot write', async () => {
    api.signOut()
    expect(await api.signIn('gwt-read')).toBe('')
    expect(api.session.writable).toBe(false)
    await open()
    expect((await api.fetchNodes()).length).toBe(3)
    const before = (await mem.changes({})).changes.length
    await expect(api.createNode({ title: 'Not allowed' })).rejects.toThrow(/may read this map but not change it/)
    // Even if the page thought otherwise, the store's 403 says the same.
    api.session.writable = true
    await expect(api.createNode({ title: 'Not allowed' })).rejects.toThrow(/may read this map but not change it/)
    api.session.writable = false
    expect((await mem.changes({})).changes.length).toBe(before)
    expect((await api.fetchNodes()).some((n) => n.title === 'Not allowed')).toBe(false)
  })
})

describe('the page as grndwrk hosts it (src/shared-store/page.ts)', () => {
  it('serves the page and, for the staging site only, the Comment button', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-page-'))
    await writeFakePage(dir)
    const url = 'https://maps.example.com/clinic/'
    const site = 'https://staging.clinic.example'
    const get = async (path: string, referer?: string) => {
      const a = await pageAnswer(dir, path, url, referer, [site])
      return a ? new Response(a.status === 301 ? null : a.body, { status: a.status, headers: a.headers }) : new Response(null, { status: 404 })
    }
    await expectServesPage(get, 'clinic', url, site)
    await rm(dir, { recursive: true, force: true })
  })
})
