import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/shared-store/memory.js'
import { storeHandler } from '../src/shared-store/http.js'
import type { StoreClient } from '../src/shared-store/protocol.js'

// The page's build points the store code's file calls at the in-memory map; so does this test.
vi.mock('../src/store/fs.js', async () => await import('../ui/src/page/vfs.js'))

const api = await import('../ui/src/api-store.js')

const PORT = 18133
const base = `http://127.0.0.1:${PORT}/clinic/`
const words = new TextEncoder()
const text = new TextDecoder()

/** Every write the page sends, with its condition, as the store sees it. */
function watching(mem: MemoryStore) {
  const writes: { path: string; create?: boolean; ifVersion?: string; removed?: boolean }[] = []
  const client: StoreClient = {
    hello: () => mem.hello(),
    changes: (o) => mem.changes(o),
    read: (p) => mem.read(p),
    write: (p, b, o) => (writes.push({ path: p, create: o.create, ifVersion: o.ifVersion }), mem.write(p, b, o)),
    remove: (p, v) => (writes.push({ path: p, removed: true, ifVersion: v }), mem.remove(p, v)),
  }
  return { client, writes }
}

describe('views saved from the page on a store', () => {
  const mem = new MemoryStore('Clinic')
  const { client, writes } = watching(mem)
  let server: Server
  let sub: { close(): void } | null = null
  const files = async () => (await mem.changes({})).changes.map((c) => c.path).filter((p) => p.startsWith('views/')).sort()

  beforeAll(async () => {
    const handle = storeHandler(client, (bearer) => (bearer === 'gwt-write' ? 'write' : null))
    server = createServer((req, res) => void handle(req, res, '/clinic/'))
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
    await mem.write('project.md', words.encode('---\nname: Clinic\n---\n'), { type: 'text/markdown', create: true })
    api.configure({ base })
    expect(await api.signIn('gwt-write')).toBe('')
    await new Promise<void>((done) => {
      sub = api.subscribe({ onEvent: () => {}, onOpen: done, onError: () => {} })
    })
  })
  afterAll(async () => {
    sub?.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('creates a view as a new file (If-None-Match), renames it with If-Match, and deletes it with If-Match', async () => {
    writes.length = 0
    const v = await api.createView({ name: 'Front desk', layout: 'outline', groupBy: 'topic', cardGroup: 'level', filters: { status: 'ready', type: '', topic: '', level: 0, who: '', waiting: '', new: false } })
    expect(writes).toEqual([{ path: `views/${v.id}.json`, create: true, ifVersion: undefined }])
    expect(JSON.parse(text.decode((await mem.read(`views/${v.id}.json`))!.bytes))).toMatchObject({ id: v.id, name: 'Front desk', layout: 'outline', filters: { status: 'ready' } })
    expect((await api.fetchViews()).map((x) => x.name)).toEqual(['Front desk'])

    const version = (await mem.read(`views/${v.id}.json`))!.version
    writes.length = 0
    expect((await api.updateView(v.id, { name: 'Reception' })).name).toBe('Reception')
    expect(writes).toEqual([{ path: `views/${v.id}.json`, create: false, ifVersion: version }])

    const now = (await mem.read(`views/${v.id}.json`))!.version
    writes.length = 0
    await api.deleteView(v.id)
    expect(writes).toEqual([{ path: `views/${v.id}.json`, removed: true, ifVersion: now }])
    expect(await files()).toEqual([])
  })

  it('keeps both of two views saved at once', async () => {
    const [a, b] = await Promise.all([api.createView({ name: 'Vets', layout: 'board', groupBy: 'page', cardGroup: 'level', filters: { status: '', type: '', topic: '', level: 0, who: '', waiting: '', new: false } }), api.createView({ name: 'Nurses', layout: 'board', groupBy: 'page', cardGroup: 'type', filters: { status: '', type: '', topic: '', level: 0, who: '', waiting: '', new: false } })])
    expect(await files()).toEqual([`views/${a.id}.json`, `views/${b.id}.json`].sort())
  })

  it('says so when someone renamed the view meanwhile, and keeps theirs', async () => {
    const [v] = (await api.fetchViews()).filter((x) => x.name === 'Vets')
    const there = (await mem.read(`views/${v.id}.json`))!
    const theirs = JSON.stringify({ ...JSON.parse(text.decode(there.bytes)), name: 'Vets on call' })
    await mem.write(`views/${v.id}.json`, words.encode(theirs), { type: 'application/json', ifVersion: there.version })
    await expect(api.updateView(v.id, { name: 'Vets today' })).rejects.toThrow(/Someone changed this view meanwhile/)
    expect(JSON.parse(text.decode((await mem.read(`views/${v.id}.json`))!.bytes)).name).toBe('Vets on call')
  })
})
