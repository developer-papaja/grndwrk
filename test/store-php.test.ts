import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkStore } from '../src/shared-store/check.js'
import { HttpStore } from '../src/shared-store/http.js'
import { expectServesPage, writeFakePage } from './page-fixture.js'

// The PHP example in stores/php, checked against the protocol like any store. Skipped without php.
const php = (() => {
  try {
    return /pdo_sqlite/.test(execFileSync('php', ['-m'], { encoding: 'utf8' }))
  } catch {
    return false
  }
})()

const app = fileURLToPath(new URL('../stores/php/', import.meta.url))
const words = new TextEncoder()
const site = 'https://staging.clinic.example'

describe.skipIf(!php)('the PHP store', () => {
  let dir = ''
  let server: ChildProcess | undefined
  let base = ''
  let url = ''
  const env = () => ({ ...process.env, GRNDWRK_STORE_CONFIG: join(dir, 'config.php') })
  const admin = (...args: string[]) => execFileSync('php', [join(app, 'admin.php'), ...args], { env: env(), encoding: 'utf8' })
  const mint = (...args: string[]) => /gwt_[0-9a-f]{48}/.exec(admin('token', 'add', ...args))![0]
  const call = (path: string, token: string, init: RequestInit = {}) => fetch(new URL(path, url), { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
  const put = (path: string, token: string, body: string, headers: Record<string, string> = { 'If-None-Match': '*' }) =>
    call(`v1/files/${path}`, token, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body })

  let writer = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gw-store-php-'))
    // A free port among 18500 to 18599.
    let port = 0
    for (let p = 18500; p < 18600 && !port; p++) {
      port = await new Promise<number>((done) => {
        const s = createServer()
        s.once('error', () => done(0))
        s.listen(p, '127.0.0.1', () => s.close(() => done(p)))
      })
    }
    if (!port) throw new Error('No free port between 18500 and 18599')
    base = `http://127.0.0.1:${port}/`
    url = `${base}clinic/`
    // A small page, so following the changes has to use `more`; small inbox limits, tried on kennel.
    const inbox = `['files_per_hour' => 5, 'mb_per_hour' => 1, 'waiting' => 4, 'total' => 8]`
    await writeFile(join(dir, 'config.php'), `<?php return ['dsn' => 'sqlite:' . ${JSON.stringify(join(dir, 'store.sqlite'))}, 'page' => 2, 'origins' => ['${site}', 'https://second.clinic.example'], 'assets' => ${JSON.stringify(join(dir, 'page'))}, 'base_url' => '${base}', 'inbox' => ${inbox}];\n`)
    await writeFakePage(join(dir, 'page'))
    admin('project', 'add', 'clinic', 'Clinic')
    admin('project', 'add', 'other')
    admin('project', 'add', 'kennel')
    writer = mint('clinic', 'write')
    // Several workers, so writes really race; in a process group of its own, so stopping it stops them too.
    const workers = process.platform === 'win32' ? {} : { PHP_CLI_SERVER_WORKERS: '4' }
    server = spawn('php', ['-S', `127.0.0.1:${port}`, join(app, 'public', 'index.php')], { env: { ...env(), ...workers }, stdio: 'ignore', detached: process.platform !== 'win32' })
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${url}v1/hello`).then((r) => r.status === 401, () => false)) return
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('php -S did not start')
  })
  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((done) => server!.once('exit', done))
      // Only the group this test started: the server and its workers.
      if (process.platform === 'win32' || !server.pid) server.kill()
      else process.kill(-server.pid, 'SIGTERM')
      await exited
    }
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('keeps every rule of the protocol, the HTTP ones too', async () => {
    const results = await checkStore(new HttpStore(url, writer), { url, token: writer })
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.length).toBe(18)
  })

  it('says who it is, and never sends a file as something to render', async () => {
    expect(await (await call('v1/hello', writer)).json()).toEqual({ protocol: 1, project: 'Clinic', writable: true, role: 'write', names: true, site })
    expect((await put('nodes/n_phpnos.md', writer, '<script>alert(1)</script>', { 'If-None-Match': '*', 'Content-Type': 'text/markdown' })).status).toBe(201)
    const res = await call('v1/files/nodes/n_phpnos.md', writer)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown(;|$)/)
    expect((await call('v1/files/nodes/%2e%2e%2fproject.md', writer)).status).toBe(400)
    expect((await call('v1/files/nodes/x.md%0a', writer)).status).toBe(400)
  })

  it('lets exactly one of several racing writes from the same version through', async () => {
    const store = new HttpStore(url, writer)
    const first = await store.write('nodes/n_phprace.md', words.encode('one'), { type: 'text/markdown', create: true })
    if (!first.ok) throw new Error('not created')
    const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => store.write('nodes/n_phprace.md', words.encode(`try ${i}`), { type: 'text/markdown', ifVersion: first.version })))
    expect(tries.filter((w) => w.ok)).toHaveLength(1)
    const won = tries.find((w) => w.ok)!
    expect(tries.filter((w) => !w.ok).every((w) => w.version === won.version)).toBe(true)
    expect((await store.read('nodes/n_phprace.md'))?.version).toBe(won.version)
  })

  it('gives a token that may only read the map, and no writes', async () => {
    const reader = mint('clinic', 'read')
    const store = new HttpStore(url, reader)
    expect(await store.hello()).toMatchObject({ writable: false, role: 'read' })
    expect((await store.changes({})).changes.length).toBeGreaterThan(0)
    await expect(store.write('nodes/n_phpread.md', words.encode('x'), { type: 'text/markdown', create: true })).rejects.toThrow(/403/)
    const there = await new HttpStore(url, writer).read('nodes/n_phpnos.md')
    expect((await call('v1/files/nodes/n_phpnos.md', reader, { method: 'DELETE', headers: { 'If-Match': `"${there!.version}"` } })).status).toBe(403)
  })

  it('lets a commenter leave comments under its own id only, and read only its own status', async () => {
    const phone = mint('clinic', 'comment', '--commenter', 'dev_phone01', '--name', 'Front desk')
    expect(await new HttpStore(url, phone).hello()).toMatchObject({ writable: false, role: 'comment', commenter: 'dev_phone01' })
    expect((await put('inbox/dev_phone01/c_00000001.json', phone, '{"text":"The button is too small","from":"Someone else"}')).status).toBe(201)
    // The name the store knows wins over the one the device sent.
    const left = await new HttpStore(url, writer).read('inbox/dev_phone01/c_00000001.json')
    expect(JSON.parse(new TextDecoder().decode(left!.bytes))).toEqual({ text: 'The button is too small', from: 'Front desk' })
    // Never twice, never without If-None-Match, never under another commenter's name.
    expect((await put('inbox/dev_phone01/c_00000001.json', phone, '{}')).status).toBe(412)
    expect((await put('inbox/dev_phone01/c_00000002.json', phone, '{}', { 'If-Match': `"${left!.version}"` })).status).toBe(403)
    expect((await put('inbox/dev_other01/c_00000002.json', phone, '{}')).status).toBe(403)
    expect((await put('inbox/dev_phone01/c_00000003.json', phone, '[1, 2]')).status).toBe(400)
    // Nothing of the map: not a card, not the changes, not someone else's status.
    expect((await put('nodes/n_phone1.md', phone, 'x')).status).toBe(403)
    expect((await call('v1/changes', phone)).status).toBe(403)
    expect((await call('v1/files/project.md', phone)).status).toBe(403)
    expect((await call('v1/files/status/dev_other01.json', phone)).status).toBe(403)
    expect((await call('v1/files/inbox/dev_phone01/c_00000001.json', phone)).status).toBe(403)
    expect((await call(`v1/files/inbox/dev_phone01/c_00000001.json`, phone, { method: 'DELETE', headers: { 'If-Match': `"${left!.version}"` } })).status).toBe(403)

    expect((await call('v1/files/status/dev_phone01.json', phone)).status).toBe(404)
    expect((await put('status/dev_phone01.json', writer, '{"comments":[]}')).status).toBe(201)
    const status = await call('v1/files/status/dev_phone01.json', phone)
    expect(status.status).toBe(200)
    expect(await status.text()).toBe('{"comments":[]}')
  })

  it('treats inbox and status as files like the others for teammates', async () => {
    const store = new HttpStore(url, writer)
    const start = await store.changes({})
    const left = await store.write('inbox/dev_tablet1/c_00000009.json', words.encode('{"text":"Hard to find the vaccine list"}'), { type: 'application/json', create: true })
    expect(left.ok).toBe(true)
    const seen: string[] = []
    for (let cursor = start.cursor, more = true; more; ) {
      const page = await store.changes({ since: cursor })
      seen.push(...page.changes.map((c) => c.path))
      cursor = page.cursor
      more = page.more === true
    }
    expect(seen).toContain('inbox/dev_tablet1/c_00000009.json')
    expect((await new HttpStore(url, mint('clinic', 'read')).read('inbox/dev_tablet1/c_00000009.json'))?.version).toBe(left.version)
    expect(await store.remove('inbox/dev_tablet1/c_00000009.json', left.ok ? left.version : '')).toMatchObject({ ok: true })
    // An inbox file is a JSON object, whoever writes it; the path, not Content-Type, decides the type.
    expect((await put('inbox/dev_tablet1/c_00000010.json', writer, 'not json')).status).toBe(400)
    expect((await put('nodes/n_phphint.md', writer, '# Hint', { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' })).status).toBe(201)
    expect((await call('v1/files/nodes/n_phphint.md', writer)).headers.get('content-type')).toMatch(/^text\/markdown/)
  })

  it('answers CORS for the staging site only, on the comment calls with a comment token', async () => {
    const phone = mint('clinic', 'comment', '--commenter', 'web_stage01')
    const from = (origin: string) => ({ Origin: origin })
    const allowed = (res: Response) => res.headers.get('access-control-allow-origin')
    expect(allowed(await call('v1/hello', phone, { headers: from(site) }))).toBe(site)
    const res = await put('inbox/web_stage01/c_00000001.json', phone, '{"text":"x"}', { 'If-None-Match': '*', ...from(site) })
    expect(res.status).toBe(201)
    expect(allowed(res)).toBe(site)
    expect(allowed(await call('v1/files/status/web_stage01.json', phone, { headers: from(site) }))).toBe(site)
    // Never another site, never a teammate's token, never the map.
    expect(allowed(await call('v1/hello', phone, { headers: from('https://elsewhere.example') }))).toBeNull()
    expect(allowed(await call('v1/hello', writer, { headers: from(site) }))).toBeNull()
    expect(allowed(await call('v1/files/project.md', writer, { headers: from(site) }))).toBeNull()
    const preflight = (path: string, origin: string) => fetch(new URL(path, url), { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' } })
    const ok = await preflight('v1/files/inbox/web_stage01/c_00000002.json', site)
    expect(ok.status).toBe(204)
    expect(allowed(ok)).toBe(site)
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, PUT')
    expect(ok.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type, If-None-Match')
    expect((await preflight('v1/files/nodes/n_x.md', site)).status).toBe(403)
    expect((await preflight('v1/changes', site)).status).toBe(403)
    expect(allowed(await preflight('v1/hello', 'https://elsewhere.example'))).toBeNull()
  })

  it('serves the page at the project\'s address, and the Comment button to the staging site only', async () => {
    await expectServesPage((path, referer) => fetch(`${base}clinic${path}`, { redirect: 'manual', headers: referer ? { Referer: referer } : {} }), 'clinic', url, site)
    // A project the store does not have gets no page.
    expect((await fetch(`${base}nowhere/`)).status).toBe(404)
  })

  it('keeps projects apart', async () => {
    expect((await fetch(`${base}other/v1/hello`, { headers: { Authorization: `Bearer ${writer}` } })).status).toBe(401)
    const other = mint('other', 'write')
    expect(await new HttpStore(`${base}other/`, other).hello()).toMatchObject({ project: 'other', writable: true })
    expect((await new HttpStore(`${base}other/`, other).changes({})).changes).toEqual([])
  })

  it('lists the one project a token belongs to at the store\'s root, read only', async () => {
    const list = (token: string, init: RequestInit = {}) => fetch(`${base}v1/projects`, { ...init, headers: { Authorization: `Bearer ${token}` } })
    const res = await list(writer)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ name: 'Clinic', url: `${base}clinic/` }] })
    expect(await (await list(mint('clinic', 'read'))).json()).toEqual({ projects: [{ name: 'Clinic', url: `${base}clinic/` }] })
    // A comment token reads no map, so it lists none; no token, or a wrong one, is 401.
    expect(await (await list(mint('clinic', 'comment', '--commenter', 'dev_listing1'))).json()).toEqual({ projects: [] })
    expect((await fetch(`${base}v1/projects`)).status).toBe(401)
    expect((await list('gwt_000000000000000000000000000000000000000000000000')).status).toBe(401)
    expect((await list(writer, { method: 'PUT', body: '{}' })).status).toBe(405)
  })

  it('sets from to the name it knows, or takes away the one the device sent, and tells teammates so', async () => {
    const nameless = mint('clinic', 'comment', '--commenter', 'dev_noname1')
    expect((await put('inbox/dev_noname1/c_00000001.json', nameless, '{"text":"Hi","from":"The vet in charge"}')).status).toBe(201)
    const left = await new HttpStore(url, writer).read('inbox/dev_noname1/c_00000001.json')
    expect(JSON.parse(new TextDecoder().decode(left!.bytes))).toEqual({ text: 'Hi' })
    expect(await (await call('v1/hello', mint('clinic', 'read'))).json()).toMatchObject({ names: true, site })
    const phone = (await (await call('v1/hello', nameless)).json()) as Record<string, unknown>
    expect([phone.names, phone.site]).toEqual([undefined, undefined])
  })

  it('names addresses from base_url, never from the Host header', async () => {
    const forged = { Host: 'evil.example' }
    const button = await fetch(`${base}clinic/store.js`, { headers: { Referer: `${site}/visits/42`, ...forged } })
    expect(await button.text()).toContain(JSON.stringify({ url, site }))
    const list = await fetch(`${base}v1/projects`, { headers: { Authorization: `Bearer ${writer}`, ...forged } })
    expect(JSON.stringify(await list.json())).not.toContain('evil')
  })

  it('holds a comment token to its limits, per commenter and for the whole project, then 429', async () => {
    const kennel = (path: string, token: string, body = '{"text":"The kennel list is hard to read"}') =>
      fetch(new URL(`v1/files/${path}`, `${base}kennel/`), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }, body })
    const owner = new HttpStore(`${base}kennel/`, mint('kennel', 'write'))
    // Waiting: four of one commenter.
    const a = mint('kennel', 'comment', '--commenter', 'dev_kennel_a')
    for (let i = 1; i <= 4; i++) expect((await kennel(`inbox/dev_kennel_a/c_0000000${i}.json`, a)).status).toBe(201)
    const waiting = await kennel('inbox/dev_kennel_a/c_00000005.json', a)
    expect(waiting.status).toBe(429)
    expect(((await waiting.json()) as { error: string }).error).toMatch(/waiting/)
    // An hour: five, though grndwrk filed the first three.
    const b = mint('kennel', 'comment', '--commenter', 'dev_kennel_b')
    for (let i = 1; i <= 3; i++) {
      const p = `inbox/dev_kennel_b/c_0000000${i}.json`
      expect((await kennel(p, b)).status).toBe(201)
      expect((await owner.remove(p, (await owner.read(p))!.version)).ok).toBe(true)
    }
    for (let i = 4; i <= 5; i++) expect((await kennel(`inbox/dev_kennel_b/c_0000000${i}.json`, b)).status).toBe(201)
    const hourly = await kennel('inbox/dev_kennel_b/c_00000006.json', b)
    expect(hourly.status).toBe(429)
    expect(((await hourly.json()) as { error: string }).error).toMatch(/an hour/)
    // Megabytes an hour.
    const c = mint('kennel', 'comment', '--commenter', 'dev_kennel_c')
    const big = JSON.stringify({ text: 'x'.repeat(600_000) })
    expect((await kennel('inbox/dev_kennel_c/c_00000001.json', c, big)).status).toBe(201)
    expect((await kennel('inbox/dev_kennel_c/c_00000002.json', c, big)).status).toBe(429)
    // Seven wait now; one more fills the project's inbox for every commenter, never for teammates.
    const d = mint('kennel', 'comment', '--commenter', 'dev_kennel_d')
    expect((await kennel('inbox/dev_kennel_d/c_00000001.json', d)).status).toBe(201)
    const full = await kennel('inbox/dev_kennel_d/c_00000002.json', d)
    expect(full.status).toBe(429)
    expect(((await full.json()) as { error: string }).error).toMatch(/Too many/)
    expect((await owner.write('inbox/dev_kennel_d/c_00000009.json', words.encode('{}'), { type: 'application/json', create: true })).ok).toBe(true)
  })

  it('stops taking a token once it is revoked', async () => {
    const token = mint('clinic', 'write', '--label', 'old laptop')
    expect((await call('v1/hello', token)).status).toBe(200)
    const id = admin('tokens', 'clinic').split('\n').find((line) => line.includes('old laptop'))!.split('\t')[0]
    admin('token', 'revoke', id)
    expect((await call('v1/hello', token)).status).toBe(401)
    expect(admin('tokens', 'clinic')).not.toContain('old laptop')
  })
})
