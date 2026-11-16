import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleApi } from '../src/server/api.js'
import { NodeStore } from '../src/store/nodes.js'
import { createView, deleteView, listViews, updateView } from '../src/store/views.js'
import { cleanSettings, readView, sameSettings } from '../src/shared/views.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-views-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const openQuestions = { layout: 'outline', groupBy: 'topic', cardGroup: 'type', filters: { status: 'all', type: 'question', topic: 'Booking', level: 2, who: 'Ada', waiting: '@Vet on duty', new: false }, part: 'p_book01', page: 'Product' }

describe('views saved for everyone (src/store/views.ts)', () => {
  it('saves one file per view, with only known values', async () => {
    const v = await createView(root, { name: '  Open questions\tby topic ', ...openQuestions, secret: 'dropped', filters: { ...openQuestions.filters, extra: 1 } }, { by: 'Ada' })
    expect(v.id).toMatch(/^v_[a-z0-9]{6}$/)
    expect(v).toMatchObject({ name: 'Open questions by topic', layout: 'outline', groupBy: 'topic', cardGroup: 'type', part: 'p_book01', page: 'Product', by: 'Ada' })
    expect(v.filters).toEqual({ status: 'all', type: 'question', topic: 'booking', level: 2, who: 'Ada', waiting: '@Vet on duty', new: false })
    const file = JSON.parse(await readFile(join(root, 'views', `${v.id}.json`), 'utf8'))
    expect(file).toEqual(v)
    expect(file.secret).toBeUndefined()
    expect(await listViews(root)).toEqual([v])
  })

  it('turns values it does not know into the defaults', async () => {
    const v = await createView(root, { name: 'Odd', layout: 'grid', groupBy: 'people', cardGroup: 'colour', filters: { status: 'finished', type: 'bug', level: 9, waiting: 'nobody', new: 'yes' }, part: '../etc', page: '*' })
    expect(cleanSettings(v)).toEqual({ layout: 'board', groupBy: 'page', cardGroup: 'level', filters: { status: '', type: '', topic: '', level: 0, who: '', waiting: '', new: false } })
  })

  it('refuses a name that is empty, more than one line, or longer than 80 characters', async () => {
    await expect(createView(root, { name: '  ' })).rejects.toThrow(/needs a name/)
    await expect(createView(root, { name: 'Two\nlines' })).rejects.toThrow(/one line/)
    await expect(createView(root, { name: 'x'.repeat(81) })).rejects.toThrow(/at most 80/)
    expect(await listViews(root)).toEqual([])
  })

  it('renames, updates its settings, and deletes', async () => {
    const v = await createView(root, { name: 'Vets', ...openQuestions })
    const renamed = await updateView(root, v.id, { name: 'Vets on duty' })
    expect(renamed).toMatchObject({ name: 'Vets on duty', layout: 'outline', created: v.created })
    const changed = await updateView(root, v.id, { settings: { ...openQuestions, layout: 'board', filters: { status: 'ready' } } })
    expect(changed).toMatchObject({ name: 'Vets on duty', layout: 'board', filters: { status: 'ready', type: '' } })
    await expect(updateView(root, v.id, { name: '' })).rejects.toThrow(/needs a name/)
    expect(await updateView(root, 'v_nobody', { name: 'x' })).toBeNull()
    expect(await deleteView(root, v.id)).toBe(true)
    expect(await deleteView(root, v.id)).toBe(false)
    expect(await listViews(root)).toEqual([])
  })

  it('keeps both of two views saved at once, in files of their own', async () => {
    const [a, b] = await Promise.all([createView(root, { name: 'Front desk' }), createView(root, { name: 'Front desk' })])
    expect(a.id).not.toBe(b.id)
    expect((await readdir(join(root, 'views'))).sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort())
    expect((await listViews(root)).map((v) => v.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('leaves a file that is not a view out of the list', async () => {
    await mkdir(join(root, 'views'))
    await writeFile(join(root, 'views', 'v_broken.json'), '{ not json')
    await writeFile(join(root, 'views', 'v_noname.json'), JSON.stringify({ id: 'v_noname', name: '' }))
    await writeFile(join(root, 'views', 'v_other1.json'), JSON.stringify({ id: 'v_someone', name: 'Wrong id' }))
    expect(await listViews(root)).toEqual([])
    expect(readView('v_ok1234', { id: 'v_ok1234', name: 'Fine' })?.name).toBe('Fine')
  })

  it('compares what two views show, not how they are written', () => {
    expect(sameSettings(cleanSettings(openQuestions), cleanSettings({ ...openQuestions, filters: { ...openQuestions.filters, topic: 'booking' } }))).toBe(true)
    expect(sameSettings(cleanSettings(openQuestions), cleanSettings({ ...openQuestions, layout: 'board' }))).toBe(false)
  })
})

describe('the views API (src/server/api.ts)', () => {
  let gw: string
  let server: Server
  let base = ''
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  beforeAll(async () => {
    gw = await mkdtemp(join(tmpdir(), 'gw-views-api-'))
    await mkdir(join(gw, 'nodes'))
    server = createServer((req, res) => void handleApi(req, res, { gwDir: gw, store: new NodeStore(gw), nodes: { sync: async () => {} } as never }))
    base = `http://127.0.0.1:${await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))}`
  })
  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await rm(gw, { recursive: true, force: true })
  })

  it('creates, lists, renames and deletes, and says why a name will not do', async () => {
    const made = await call('POST', '/api/views', { name: 'Ready to test', layout: 'board', filters: { status: 'ready' } })
    expect(made.status).toBe(201)
    const v = await made.json()
    expect((await (await call('GET', '/api/views')).json()).map((x: { id: string }) => x.id)).toEqual([v.id])
    const renamed = await call('PATCH', `/api/views/${v.id}`, { name: 'To test' })
    expect((await renamed.json()).name).toBe('To test')
    const bad = await call('PATCH', `/api/views/${v.id}`, { name: 'a\nb' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/one line/)
    expect((await call('POST', '/api/views', { name: '' })).status).toBe(400)
    expect((await call('DELETE', `/api/views/${v.id}`)).status).toBe(204)
    expect((await call('DELETE', `/api/views/${v.id}`)).status).toBe(404)
    expect((await call('PATCH', '/api/views/v_zzzzzz', { name: 'x' })).status).toBe(404)
  })
})
