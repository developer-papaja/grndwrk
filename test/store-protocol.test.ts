import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkStore } from '../src/shared-store/check.js'
import { adapterState, AdapterNotAllowed, allowAdapter, loadAdapter } from '../src/shared-store/config.js'
import { HttpStore, storeHandler } from '../src/shared-store/http.js'
import { MemoryStore } from '../src/shared-store/memory.js'
import { CursorGone, pathProblem } from '../src/shared-store/protocol.js'

describe('which paths a store keeps', () => {
  it('keeps the map, never what belongs to one machine', () => {
    for (const ok of ['project.md', 'nodes/n_abc123.md', 'threads/n_abc123/1794850638334-xl.md', 'files/n_abc123/plan.png', 'readiness/gaps/gap_x.json']) expect(pathProblem(ok)).toBe('')
    for (const no of ['local.json', 'lan-code', 'lan-devices.json', 'shots/web/p_x.png', 'store.json', 'CLAUDE.md', 'nodes/../local.json', '/nodes/x.md', 'nodes/.hidden.md', 'nodes\\x.md', 'nodes/x.svg', 'nodes/x.html', '']) expect(pathProblem(no)).not.toBe('')
  })
})

describe('the in-memory store', () => {
  it('keeps every rule of the protocol', async () => {
    const results = await checkStore(new MemoryStore())
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.length).toBeGreaterThan(10)
  })

  it('pages changes with more, and holds a long poll until something changes', async () => {
    const s = new MemoryStore('T', true, 2)
    const start = await s.changes({})
    for (const n of ['a', 'b', 'c']) await s.write(`nodes/n_${n}aaaaa.md`, new TextEncoder().encode(n), { type: 'text/markdown', create: true })
    const first = await s.changes({ since: start.cursor })
    expect(first.changes).toHaveLength(2)
    expect(first.more).toBe(true)
    const rest = await s.changes({ since: first.cursor })
    expect(rest.changes.map((c) => c.path)).toEqual(['nodes/n_caaaaa.md'])
    const waiting = s.changes({ since: rest.cursor, wait: 5 })
    setTimeout(() => s.write('nodes/n_daaaaa.md', new TextEncoder().encode('d'), { type: 'text/markdown', create: true }), 50)
    expect((await waiting).changes.map((c) => c.path)).toEqual(['nodes/n_daaaaa.md'])
  })
})

describe('over HTTP', () => {
  let server: Server
  let url = ''
  beforeAll(async () => {
    const handle = storeHandler(new MemoryStore('Clinic'), (t) => (t === 'writer' ? 'write' : t === 'reader' ? 'read' : null))
    server = createServer((req, res) => void handle(req, res, '/clinic/'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/clinic/`
  })
  afterAll(() => new Promise<void>((done) => server.close(() => done())))

  it('keeps every rule, the HTTP ones too', async () => {
    const results = await checkStore(new HttpStore(url, 'writer'), { url, token: 'writer' })
    expect(results.filter((r) => !r.ok)).toEqual([])
  })

  it('says a token that may only read is not writable, and refuses its writes', async () => {
    const store = new HttpStore(url, 'reader')
    expect((await store.hello()).writable).toBe(false)
    await expect(store.write('nodes/n_rdonly.md', new TextEncoder().encode('x'), { type: 'text/markdown', create: true })).rejects.toThrow(/403/)
  })

  it('never sends a token in the clear to another machine', () => {
    expect(() => new HttpStore('http://maps.example.com/clinic/', 't')).toThrow(/https/)
    expect(() => new HttpStore('https://user:pw@maps.example.com/', 't')).toThrow(/token/)
    expect(() => new HttpStore('https://maps.example.com/clinic/', 't')).not.toThrow()
  })
})

describe('adapters', () => {
  let root = ''
  const stateDirBefore = process.env.GRNDWRK_STORE_DIR
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gw-adapter-'))
    process.env.GRNDWRK_STORE_DIR = join(root, 'state')
    await mkdir(join(root, 'tools'))
    // An adapter that keeps the map in memory, as one in a team's repo would keep it in their database.
    // One file, no imports: the test hands it the store through a global.
    ;(globalThis as Record<string, unknown>).__testStore = (project: string) => new MemoryStore(project)
    await writeFile(join(root, 'tools', 'store.mjs'), 'export default async ({ project }) => globalThis.__testStore(project)\n')
  })
  afterAll(async () => {
    if (stateDirBefore === undefined) delete process.env.GRNDWRK_STORE_DIR
    else process.env.GRNDWRK_STORE_DIR = stateDirBefore
    await rm(root, { recursive: true, force: true })
  })

  it('is loaded only after it was allowed, and passes the same check', async () => {
    expect(await adapterState(root, 'tools/store.mjs')).toBe('never')
    await expect(loadAdapter(root, 'tools/store.mjs', 'Clinic')).rejects.toThrow(AdapterNotAllowed)
    await allowAdapter(root, 'tools/store.mjs')
    const store = await loadAdapter(root, 'tools/store.mjs', 'Clinic')
    expect((await store.hello()).project).toBe('Clinic')
    expect((await checkStore(store)).filter((r) => !r.ok)).toEqual([])
  })

  it('stops loading it once the file changed, until allowed again', async () => {
    await allowAdapter(root, 'tools/store.mjs')
    await writeFile(join(root, 'tools', 'store.mjs'), `${'// changed by a pull request\n'}export default async () => { throw new Error('ran') }\n`)
    expect(await adapterState(root, 'tools/store.mjs')).toBe('changed')
    await expect(loadAdapter(root, 'tools/store.mjs', 'Clinic')).rejects.toThrow(/changed since it was allowed/)
  })

  it('refuses an adapter that imports a file of the repository, or an address it works out', async () => {
    for (const [name, src] of [
      ['rel.mjs', "import { x } from './helper.mjs'\nexport default async () => x\n"],
      ['abs.mjs', "import x from '/tmp/x.mjs'\nexport default async () => x\n"],
      ['dyn.mjs', "export default async () => (await import('../x.mjs')).default\n"],
      ['computed.mjs', "const p = './x.mjs'\nexport default async () => (await import(p)).default\n"],
      ['req.mjs', "const x = require('./x.cjs')\nexport default async () => x\n"],
    ]) {
      await writeFile(join(root, 'tools', name), src)
      await expect(allowAdapter(root, `tools/${name}`)).rejects.toThrow(/cannot be allowed/)
    }
    // Installed packages are fine, and a URL in a comment is not an import.
    await writeFile(join(root, 'tools', 'pkg.mjs'), "import { createHash } from 'node:crypto'\n// see https://example.com/docs\nexport default async () => createHash\n")
    await expect(allowAdapter(root, 'tools/pkg.mjs')).resolves.toMatch(/^[a-f0-9]{64}$/)
  })

  it('turns an adapter error named CursorGone into a 410', async () => {
    await writeFile(join(root, 'tools', 'gone.mjs'), "export default async ({ project }) => { const s = globalThis.__testStore(project); return Object.assign(Object.create(s), { changes: async (o) => { if (o.since) { const e = new Error('gone'); e.name = 'CursorGone'; throw e } return s.changes(o) }, hello: () => s.hello(), read: (p) => s.read(p), write: (...a) => s.write(...a), remove: (...a) => s.remove(...a) }) }\n")
    await allowAdapter(root, 'tools/gone.mjs')
    const store = await loadAdapter(root, 'tools/gone.mjs', 'Clinic')
    await expect(store.changes({ since: 'c_99' })).rejects.toBeInstanceOf(CursorGone)
  })

  it('refuses an adapter outside the project, a link, or anything but .mjs', async () => {
    await expect(allowAdapter(root, '../elsewhere.mjs')).rejects.toThrow(/inside the project/)
    await expect(allowAdapter(root, 'tools/store.js')).rejects.toThrow(/\.mjs/)
    await writeFile(join(root, 'real.mjs'), 'export default async () => ({})\n')
    await symlink(join(root, 'real.mjs'), join(root, 'tools', 'linked.mjs'))
    await expect(allowAdapter(root, 'tools/linked.mjs')).rejects.toThrow(/link/)
  })
})

describe('comments straight to the store', () => {
  let server: Server
  let url = ''
  const memory = new MemoryStore('Clinic')
  beforeAll(async () => {
    const handle = storeHandler(memory, (t) => (t === 'writer' ? 'write' : t === 'phone' ? { role: 'comment', commenter: 'dev_phone01' } : null))
    server = createServer((req, res) => void handle(req, res, '/'))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((done) => server.close(() => done())))
  const put = (path: string, token: string, body = '{"text":"The button is too small"}') =>
    fetch(new URL(`v1/files/${path}`, url), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body })

  it('lets a commenter leave a comment in the inbox, and nothing else', async () => {
    expect((await put('inbox/dev_phone01/c_00000001.json', 'phone')).status).toBe(201)
    // Never under another commenter's name.
    expect((await put('inbox/dev_other01/c_00000002.json', 'phone')).status).toBe(403)
    expect((await new HttpStore(url, 'phone').hello()).role).toBe('comment')
    // Never the map: not a card, not the changes, not someone else's status.
    expect((await put('nodes/n_phone1.md', 'phone', 'x')).status).toBe(403)
    expect((await fetch(new URL('v1/changes', url), { headers: { Authorization: 'Bearer phone' } })).status).toBe(403)
    expect((await fetch(new URL('v1/files/project.md', url), { headers: { Authorization: 'Bearer phone' } })).status).toBe(403)
    expect((await fetch(new URL('v1/files/status/dev_other01.json', url), { headers: { Authorization: 'Bearer phone' } })).status).toBe(403)
  })

  it('lets a commenter read its own status, written by grndwrk', async () => {
    await memory.write('status/dev_phone01.json', new TextEncoder().encode('{"comments":[]}'), { type: 'application/json', create: true })
    const res = await fetch(new URL('v1/files/status/dev_phone01.json', url), { headers: { Authorization: 'Bearer phone' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"comments":[]}')
  })
})
