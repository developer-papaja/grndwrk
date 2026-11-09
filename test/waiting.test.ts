import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { readWaiting, setPersonalInfo, setWaiting } from '../src/store/waiting.js'
import { readProject } from '../src/store/project.js'
import { personalInfo, waitingKey } from '../src/shared/waiting.js'
import { handleApi } from '../src/server/api.js'

let gw: string
let local: string
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-waiting-'))
  local = join(gw, '..', `${basename(gw)}-state`, 'waiting.json')
  process.env.GRNDWRK_WAITING_FILE = local
  await writeFile(join(gw, 'project.md'), '---\nname: Clinic\nstart: new\n---\nNotes\n')
})
afterEach(async () => {
  delete process.env.GRNDWRK_WAITING_FILE
  await rm(gw, { recursive: true, force: true })
  await rm(join(local, '..'), { recursive: true, force: true })
})

const marks = async () => (await readdir(join(gw, 'waiting')).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
const mark = async (name: string) => JSON.parse(await readFile(join(gw, 'waiting', name), 'utf8'))
const Q = 'Which day do bookings open?\n\nOptions:\n- Monday\n- Today'

describe('the key of a question', () => {
  it('is the owner and a hash of its first line, whatever the case and punctuation', () => {
    expect(waitingKey('n_abc123', Q)).toMatch(/^n_abc123-[0-9a-f]{8}$/)
    expect(waitingKey('n_abc123', 'which day do bookings open')).toBe(waitingKey('n_abc123', Q))
    expect(waitingKey('n_abc123', 'Who pays?')).not.toBe(waitingKey('n_abc123', Q))
    expect(waitingKey('p_home', Q)).not.toBe(waitingKey('n_abc123', Q))
  })

  it('reads personal_info as yes, no or not said', () => {
    expect(personalInfo({ personal_info: 'yes' })).toBe('yes')
    expect(personalInfo({ personal_info: false })).toBe('no')
    expect(personalInfo({})).toBe(null)
  })
})

describe('questions waiting for someone', () => {
  it('keeps names off the map unless it may hold them', async () => {
    const w = await setWaiting(gw, { on: 'n_abc123', question: Q, for: 'Person 1' })
    const [file] = await marks()
    expect(file).toBe(`${waitingKey('n_abc123', Q)}.json`)
    expect(await mark(file)).toEqual({ on: 'n_abc123', question: 'Which day do bookings open?', since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(await readFile(join(gw, 'project.md'), 'utf8')).not.toContain('Person 1')
    // On this Mac, the name is still there.
    expect(w.items[0].for).toBe('Person 1')
    expect(w.people).toEqual(['Person 1'])
    const stored = JSON.parse(await readFile(local, 'utf8'))
    expect(stored[resolve(gw)].for[waitingKey('n_abc123', Q)]).toBe('Person 1')
  })

  it('writes names into the map when it may hold them, and the list into project.md', async () => {
    await setPersonalInfo(gw, 'yes')
    await setWaiting(gw, { on: 'n_abc123', question: Q, for: 'Person 2' })
    expect(await mark((await marks())[0])).toMatchObject({ for: 'Person 2' })
    expect((await readProject(gw)).data.people).toEqual(['Person 2'])
    expect((await readProject(gw)).data.personal_info).toBe('yes')
  })

  it('marks a question as waiting for anyone, moves it to someone, and clears it', async () => {
    await setPersonalInfo(gw, 'yes')
    let w = await setWaiting(gw, { on: 'n_abc123', question: Q, for: null })
    expect(w.items).toEqual([expect.objectContaining({ on: 'n_abc123' })])
    expect(w.items[0].for).toBeUndefined()
    const since = w.items[0].since
    w = await setWaiting(gw, { on: 'n_abc123', question: Q, for: 'Person 1' })
    expect(w.items).toHaveLength(1)
    expect(w.items[0]).toMatchObject({ for: 'Person 1', since })
    w = await setWaiting(gw, { on: 'n_abc123', question: Q, clear: true })
    expect(w.items).toEqual([])
    expect(await marks()).toEqual([])
  })

  it('moves names out of the map when it may no longer hold them, and back', async () => {
    await setPersonalInfo(gw, 'yes')
    await setWaiting(gw, { on: 'n_abc123', question: Q, for: 'Person 1' })
    await setPersonalInfo(gw, 'no')
    expect(await mark((await marks())[0])).not.toHaveProperty('for')
    const project = await readFile(join(gw, 'project.md'), 'utf8')
    expect(project).not.toContain('Person 1')
    expect(project).toContain('Notes')
    expect((await readWaiting(gw)).items[0].for).toBe('Person 1')

    await setPersonalInfo(gw, 'yes')
    expect(await mark((await marks())[0])).toMatchObject({ for: 'Person 1' })
    expect((await readProject(gw)).data.people).toEqual(['Person 1'])
  })

  it('leaves this Mac untouched for a project that never named anyone', async () => {
    await setPersonalInfo(gw, 'no')
    await setWaiting(gw, { on: 'n_abc123', question: Q })
    await expect(readFile(local, 'utf8')).rejects.toThrow()
  })

  it('skips a file that cannot be read', async () => {
    await mkdir(join(gw, 'waiting'), { recursive: true })
    await writeFile(join(gw, 'waiting', 'n_abc123-0000abcd.json'), '{ not json')
    await writeFile(join(gw, 'waiting', 'notes.txt'), 'x')
    expect((await readWaiting(gw)).items).toEqual([])
  })
})

describe('the waiting API', () => {
  let server: Server
  let base: string
  let store: NodeStore
  beforeEach(async () => {
    store = new NodeStore(gw)
    server = createServer((req, res) => void handleApi(req, res, { gwDir: gw, store, nodes: { sync: async () => {} } as never }))
    base = `http://127.0.0.1:${await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('marks a question on a thought, and refuses unknown cards and odd input', async () => {
    const n = (await store.create({ title: 'Booking', body: `## Thread\n\n**Claude asks** · 2026-11-09\n${Q}\n` })).upserted[0]
    const res = await post('/api/waiting', { on: n.id, question: Q, for: 'Person 1' })
    expect(res.status).toBe(200)
    expect((await res.json()).items[0]).toMatchObject({ on: n.id, for: 'Person 1' })
    expect((await (await fetch(`${base}/api/waiting`)).json()).people).toEqual(['Person 1'])
    expect((await post('/api/waiting', { on: 'n_nothere', question: Q })).status).toBe(404)
    expect((await post('/api/waiting', { on: '../x', question: Q })).status).toBe(400)
    expect((await post('/api/waiting', { on: n.id, question: '' })).status).toBe(400)
    expect((await post('/api/waiting', { on: n.id, question: Q, for: 3 })).status).toBe(400)
  })

  it('says whether the map may hold names', async () => {
    expect((await post('/api/waiting/personal-info', { value: 'maybe' })).status).toBe(400)
    const res = await post('/api/waiting/personal-info', { value: 'no' })
    expect((await res.json()).personal_info).toBe('no')
    expect((await readProject(gw)).data.personal_info).toBe('no')
  })
})

describe('names that hold list characters', () => {
  it('stay one name each, and project.md stays readable', async () => {
    const { mkdtemp, writeFile: write, mkdir: mk, readFile: read } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const { writeFields, readProject } = await import('../src/store/project.js')
    const dir = await mkdtemp(j(tmpdir(), 'gw-flow-'))
    const gw = j(dir, '.grndwrk')
    await mk(gw, { recursive: true })
    await write(j(gw, 'project.md'), '---\nname: Clinic\n---\n')
    const names = ['Vet, Anna', 'x {y}', 'a]b', 'Dr #2', 'Plain Name']
    await writeFields(gw, { people: names, pages: ['Product, v2', 'Feedback'] })
    const { data } = await readProject(gw)
    expect(data.people).toEqual(names)
    expect(data.pages).toEqual(['Product, v2', 'Feedback'])
    expect(await read(j(gw, 'project.md'), 'utf8')).toContain('Plain Name]')
  })
})
