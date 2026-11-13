import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Relay, type Store } from '../relay/src/relay.js'
import { NodeStore } from '../src/store/nodes.js'
import { NodeSync } from '../src/server/events.js'
import { RelayClient } from '../src/relay/client.js'
import { RelaySync, joinDigits } from '../src/relay/sync.js'
import { parseLink, projectRelay, saveProjectRelay, siteOrigin, teamLink, type ProjectRelay } from '../src/relay/config.js'
import { inviteId, open, ownerAuthKey, phoneSealKey, phoneSignKey, randomId, randomKey, relayDeviceId, requestSignature, seal, sealJson, teamAuthKey } from '../src/relay/keys.js'

class MemoryStore implements Store {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put(key: string, value: unknown) { this.data.set(key, value) }
  async delete(keys: string[]) { for (const k of keys) this.data.delete(k) }
  async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? Infinity)
    return new Map(keys.map((k) => [k, this.data.get(k) as T]))
  }
}

let server: Server
let url: string
let gw: string
let store: NodeStore
const owner = randomKey()

beforeEach(async () => {
  // The relay, as the Worker runs it: a mailbox per path, each with its own storage.
  const stores = new Map<string, MemoryStore>()
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c)
    const mb = /^\/v1\/([a-f0-9]{32})/.exec(req.url ?? '')?.[1] ?? 'none'
    if (!stores.has(mb)) stores.set(mb, new MemoryStore())
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    })
    const out = await new Relay(stores.get(mb)!, ownerAuthKey(owner)).handle(request)
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://localhost:${(server.address() as AddressInfo).port}`
  gw = await mkdtemp(join(tmpdir(), 'gw-relay-'))
  await mkdir(join(gw, 'nodes'))
  store = new NodeStore(gw)
  process.env.GRNDWRK_RELAY_DIR = join(gw, 'state')
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(gw, { recursive: true, force: true })
  delete process.env.GRNDWRK_RELAY_DIR
})

/** What `relay add` does: a mailbox for the project, opened with the owner key. */
async function project(): Promise<ProjectRelay> {
  const r = { url, mailbox: randomId(), team: randomKey() }
  await RelayClient.owner(url, r.mailbox, owner).json('PUT', '', { team: teamAuthKey(r.team) })
  return r
}

/** What the app will do: join with the invite link, then leave sealed requests and read its status. */
async function phone(link: string) {
  const { url: base, mailbox, secret } = parseLink(link, 'invite')
  const key = randomKey()
  const inv = inviteId(secret)
  const joined = await fetch(`${base}/v1/${mailbox}/join/${inv}`, { method: 'POST', body: Buffer.from(sealJson(secret, `join:${inv}`, { key }), 'base64') })
  expect(joined.status).toBe(202)
  const sign = phoneSignKey(key)
  const id = relayDeviceId(sign)
  const signed = async (method: string, rest: string, body = Buffer.alloc(0)) => {
    const path = `/v1/${mailbox}${rest}`
    const time = String(Date.now())
    const nonce = randomKey().slice(0, 24)
    return fetch(base + path, {
      method,
      body: method === 'GET' ? undefined : body,
      headers: { 'x-grndwrk-device': id, 'x-grndwrk-time': time, 'x-grndwrk-nonce': nonce, 'x-grndwrk-signature': requestSignature(sign, method, path, time, nonce, body) },
    })
  }
  const envelope = (path: string, body: unknown, at = Date.now()) => seal(phoneSealKey(key), `inbox:${id}`, Buffer.from(JSON.stringify({ path, body, id: randomKey().slice(0, 32), at })))
  return {
    id,
    digits: joinDigits(key),
    envelope,
    leave: (sealed: Buffer) => signed('POST', '/inbox', sealed),
    send: (path: string, body: unknown) => signed('POST', '/inbox', envelope(path, body)),
    async status() {
      const res = await signed('GET', '/outbox')
      if (res.status === 204) return undefined
      return JSON.parse(open(phoneSealKey(key), `outbox:${id}`, Buffer.from(await res.arrayBuffer()))!.toString()) as { comments: Record<string, unknown>[] }
    },
  }
}

const ctx = () => ({ gwDir: gw, store, nodes: new NodeSync(() => store.list()), project: 'Rooms', uiUrl: 'http://localhost:1' })

describe('relay and grndwrk', () => {
  it('tries a comment again when it failed for a passing reason, instead of dropping it as seen', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const { chmod } = await import('node:fs/promises')
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const { link } = await sync.invite('Anna')
    const p = await phone(link)
    await sync.tick()
    await sync.answerJoin((await sync.summary()).waiting[0].invite, true)
    expect((await p.send('/api/feedback', { text: 'Book is cut off', key: 'k'.repeat(20) })).status).toBe(202)
    // The map's folder cannot be written for a moment: the comment stays at the relay.
    await chmod(join(gw, 'nodes'), 0o500)
    const quiet = console.error
    console.error = () => {}
    try {
      await sync.tick()
    } finally {
      console.error = quiet
      await chmod(join(gw, 'nodes'), 0o700)
    }
    expect(await store.list()).toEqual([])
    await sync.tick()
    expect((await store.list()).map((n) => n.title)).toEqual(['Book is cut off'])
  })

  it('brings a colleague’s comment into the map, with their name, and their status back', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const { link, name } = await sync.invite('Anna‮')
    expect(name).toBe('Anna')
    expect((await sync.summary()).invites.map((i) => i.name)).toEqual(['Anna'])

    const p = await phone(link)
    expect((await p.send('/api/feedback', { text: 'Book is cut off', key: 'k'.repeat(20) })).status).toBe(401)
    // The link alone lets nobody in: the phone waits, with digits it shows too, until someone allows it.
    await sync.tick()
    expect(sync.error).toBeUndefined()
    const before = await sync.summary()
    expect(before.waiting).toEqual([{ invite: expect.any(String), name: 'Anna', digits: p.digits }])
    expect(before.phones).toEqual([])
    expect((await p.send('/api/feedback', { text: 'Book is cut off', key: 'k'.repeat(20) })).status).toBe(401)
    await sync.answerJoin(before.waiting[0].invite, true)
    const summary = await sync.summary()
    expect(summary.phones.map((x) => x.name)).toEqual(['Anna'])
    expect(summary.invites).toEqual([])
    expect(summary.waiting).toEqual([])

    expect((await p.send('/api/feedback', { text: 'Book is cut off', key: 'k'.repeat(20), platform: 'iOS' })).status).toBe(202)
    await sync.tick()
    const [node] = await store.list()
    expect(node.title).toBe('Book is cut off')
    expect(node.extra).toMatchObject({ source: 'app', via: 'relay', from: 'Anna', relay_device: p.id, key: 'k'.repeat(20) })

    const s1 = await p.status()
    expect(s1?.comments).toMatchObject([{ id: node.id, key: 'k'.repeat(20), state: 'incoming' }])

    // Built: ready to test on the phone, and the phone rejects it through the relay.
    await store.update(node.id, { proposed: '2026-11-05', built: '2026-11-05', body: `${node.body}\n## Thread\n\n**Claude** · 2026-11-05\nWider button.\n\nTo test:\n1. Open Book.\n` })
    await sync.tick()
    expect((await p.status())?.comments[0]).toMatchObject({ state: 'ready', test: '1. Open Book.' })
    await p.send('/api/feedback/tested', { comments: [{ id: node.id, key: 'k'.repeat(20) }], works: false, note: 'Still cut off' })
    await sync.tick()
    expect((await store.get(node.id)).body).toContain('> Still cut off')
    expect((await p.status())?.comments[0]).toMatchObject({ state: 'incoming' })
  })

  it('settles a fix when the phone sends back the round it got with its status, and not for an older round', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const p = await phone((await sync.invite('Ed')).link)
    await sync.tick()
    await sync.answerJoin((await sync.summary()).waiting[0].invite, true)
    await p.send('/api/feedback', { text: 'Ring too small', key: 'e'.repeat(20) })
    await sync.tick()
    const [node] = await store.list()
    const today = new Date().toISOString().slice(0, 10)
    await store.update(node.id, { proposed: today, built: today, body: `${node.body}\n## Thread\n\n**Claude** · ${today}\nBigger.\n\nTo test:\n1. Open Today.\n` })
    await sync.tick()
    const old = (await p.status())!.comments[0].round as string
    expect(old).toMatch(/^[0-9a-f]{16}$/)
    // Built again: the phone still holding the old round settles nothing.
    const now = (await store.get(node.id))!
    await store.update(node.id, { body: `${now.body}\n\n**Claude** · ${today}\nEven bigger.\n\nTo test:\n1. Open Today.\n` })
    await p.send('/api/feedback/tested', { comments: [{ id: node.id, key: 'e'.repeat(20), round: old }], works: true })
    await sync.tick()
    expect((await store.get(node.id))!.extra.fixed).toBeUndefined()
    const fresh = (await p.status())!.comments[0].round as string
    expect(fresh).not.toBe(old)
    await p.send('/api/feedback/tested', { comments: [{ id: node.id, key: 'e'.repeat(20), round: fresh }], works: true })
    await sync.tick()
    expect((await store.get(node.id))!.extra.fixed).toBe(today)
  })

  it('ignores a test result sealed before the fix was built', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const p = await phone((await sync.invite('Di')).link)
    await sync.tick()
    await sync.answerJoin((await sync.summary()).waiting[0].invite, true)
    await p.send('/api/feedback', { text: 'Ring too small', key: 'd'.repeat(20) })
    await sync.tick()
    const [node] = await store.list()
    await store.update(node.id, { proposed: '2026-11-07', built: '2026-11-09', body: `${node.body}\n## Thread\n\n**Claude** · 2026-11-09\nBigger.\n\nTo test:\n1. Open Today.\n` })
    // Sealed two days before the build: an old result handed over again.
    const day = Date.UTC(2026, 10, 7, 12)
    const old = p.envelope('/api/feedback/tested', { comments: [{ id: node.id, key: 'd'.repeat(20) }], works: true }, day)
    expect((await p.leave(old)).status).toBe(202)
    const real = Date.now
    Date.now = () => day + 60_000
    try {
      await sync.tick()
    } finally {
      Date.now = real
    }
    expect((await store.get(node.id))!.extra.fixed).toBeUndefined()
  })

  it('lets any teammate’s grndwrk let a phone in and open its comments, with the team link', async () => {
    const r = await project()
    const mine = new RelaySync(r, ctx())
    const { link } = await mine.invite('Bo')
    const p = await phone(link)

    const joined = parseLink(teamLink(r), 'team')
    const theirs = new RelaySync({ url: joined.url, mailbox: joined.mailbox, team: joined.secret }, ctx())
    await theirs.tick()
    await theirs.answerJoin((await theirs.summary()).waiting[0].invite, true)
    await p.send('/api/feedback', { text: 'From Bo', key: 'b'.repeat(20) })
    await mine.tick()
    expect((await store.list()).map((n) => [n.title, n.extra.from])).toEqual([['From Bo', 'Bo']])
  })

  it('takes nothing from another team, a changed envelope, or a phone taken out', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const p = await phone((await sync.invite('Cy')).link)
    await sync.tick()
    await sync.answerJoin((await sync.summary()).waiting[0].invite, true)

    // Another project's team cannot read this mailbox.
    const other = new RelaySync({ ...r, team: randomKey() }, ctx())
    await other.tick()
    expect(other.error).toMatch(/Not signed/)

    // Something a phone never sends, and the status path, are dropped.
    await p.send('/api/nodes', { title: 'x' })
    await p.send('/api/feedback/status', { comments: [] })
    await sync.tick()
    expect(await store.list()).toEqual([])
    expect(await (await RelayClient.team(r.url, r.mailbox, r.team).request('GET', '/inbox')).json()).toEqual([])

    await sync.removePhone(p.id)
    expect((await p.send('/api/feedback', { text: 'After', key: 'c'.repeat(20) })).status).toBe(401)
    expect((await sync.summary()).phones).toEqual([])
  })

  it('keeps each project’s mailbox and team key on this Mac, out of the project', async () => {
    const r = await project()
    await saveProjectRelay(gw, r)
    expect(await projectRelay(gw)).toEqual(r)
    expect(await projectRelay(join(gw, 'other'))).toBeUndefined()
    // Links are not web addresses: opened in a browser they would hand the secret to the relay's page.
    expect(teamLink(r)).toMatch(/^grndwrk:team\/localhost:\d+\/[a-f0-9]{32}\/[a-f0-9]{64}$/)
    expect(parseLink(`grndwrk:team/relay.example.workers.dev/${'a'.repeat(32)}/${'b'.repeat(64)}`, 'team').url).toBe('https://relay.example.workers.dev')
    expect(() => parseLink(`https://relay.example/v1/${'a'.repeat(32)}/team#${'b'.repeat(64)}`, 'team')).toThrow(/Not a team link/)
    expect(() => parseLink(`grndwrk:invite/relay.example/${'a'.repeat(32)}/${'b'.repeat(64)}`, 'team')).toThrow(/Not a team link/)
    expect(() => parseLink(`grndwrk:team/evil.example@relay/${'a'.repeat(32)}/${'b'.repeat(64)}`, 'team')).toThrow()
    await saveProjectRelay(gw, null)
    expect(await projectRelay(gw)).toBeUndefined()
  })

  it('refuses an envelope handed over again, or too old, and lets a phone act only on its own comments', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const anna = await phone((await sync.invite('Anna')).link)
    const bo = await phone((await sync.invite('Bo')).link)
    await sync.tick()
    for (const w of (await sync.summary()).waiting) await sync.answerJoin(w.invite, true)

    // The relay keeps a copy and hands it over again after it was fetched: the second is refused.
    const once = anna.envelope('/api/feedback', { text: 'First', key: 'a'.repeat(20) })
    await anna.leave(once)
    await sync.tick()
    const [first] = await store.list()
    await store.delete(first.id)
    await anna.leave(once)
    await sync.tick()
    expect(await store.list()).toEqual([])

    // One sealed long ago is refused too.
    await anna.leave(anna.envelope('/api/feedback', { text: 'Old', key: 'o'.repeat(20) }, Date.now() - 40 * 86_400_000))
    await sync.tick()
    expect(await store.list()).toEqual([])

    // Bo knows Anna's comment's id and key (they are in the repo), but cannot approve or delete it.
    await anna.send('/api/feedback', { text: 'Anna again', key: 'b'.repeat(20) })
    await sync.tick()
    const [node] = await store.list()
    await store.update(node.id, { proposed: '2026-11-05', built: '2026-11-05' })
    await bo.send('/api/feedback/tested', { comments: [{ id: node.id, key: 'b'.repeat(20) }], works: true })
    await bo.send('/api/feedback/remove', { comments: [{ id: node.id, key: 'b'.repeat(20) }] })
    await sync.tick()
    const still = await store.get(node.id)
    expect(still.extra.fixed).toBeUndefined()
    // Anna can.
    await anna.send('/api/feedback/tested', { comments: [{ id: node.id, key: 'b'.repeat(20) }], works: true })
    await sync.tick()
    expect((await store.get(node.id)).extra.fixed).toMatch(/^\d{4}-/)
  })

  it('lets nobody in who joins with a used or withdrawn invite, and drops a phone that was not allowed', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const { link } = await sync.invite('Dee')
    const p = await phone(link)
    await sync.tick()
    await sync.answerJoin((await sync.summary()).waiting[0].invite, false)
    expect((await sync.summary()).phones).toEqual([])
    expect((await p.send('/api/feedback', { text: 'x', key: 'd'.repeat(20) })).status).toBe(401)
    await expect(sync.answerJoin('f'.repeat(32), true)).rejects.toThrow(/no longer waiting/)
  })

  it('brings a comment from a browser on the staging site, joined with an invite like a phone', async () => {
    await import('../overlay/relay.js')
    const factory = (globalThis as unknown as { __grndwrkRelayFactory: (c: object, k: object, f: typeof fetch) => BrowserRelay }).__grndwrkRelayFactory
    const r = await project()
    const site = 'https://staging.clinic.example'
    await RelayClient.team(r.url, r.mailbox, r.team).json('PUT', '/site', { site })
    const sync = new RelaySync(r, ctx())
    const { link } = await sync.invite('Tess')

    // What the browser keeps: here in memory, on the site in IndexedDB.
    const kept = new Map<string, unknown>()
    const keep = { get: async (k: string) => kept.get(k), put: async (k: string, v: unknown) => void kept.set(k, v), remove: async (k: string) => void kept.delete(k) }
    const browser = factory({ url: r.url, mailbox: r.mailbox, site }, keep, fetch)
    const comment = (text: string, url: string) => ({ text, platform: 'Web', screen: '/visits/3', url, written: new Date().toISOString(), element: { label: 'Save', role: 'button' } })

    expect(await browser.post(comment('Save is hidden', `${site}/visits/3`))).toBe('join')
    await expect(browser.join(link.replace(r.mailbox, 'a'.repeat(32)))).rejects.toThrow(/another project/)
    const digits = await browser.join(link)
    // The key itself is not kept, only what signs and seals, as keys.
    expect(JSON.stringify([...kept.values()])).not.toMatch(/[a-f0-9]{64}/)
    expect(await browser.post(comment('Save is hidden', `${site}/visits/3`))).toBe('asked')
    expect(await browser.allowed()).toBe(false)

    await sync.tick()
    const [waiting] = (await sync.summary()).waiting
    expect(waiting).toMatchObject({ name: 'Tess', digits })
    await sync.answerJoin(waiting.invite, true)
    expect(await browser.allowed()).toBe(true)

    expect(await browser.post(comment('Save is hidden', `${site}/visits/3`))).toBe('sent')
    // An address on another site is not kept.
    expect(await browser.post(comment('Logo is blurry', 'https://elsewhere.example/phish'))).toBe('sent')
    await sync.tick()
    const nodes = await store.list()
    const save = nodes.find((n) => n.title === 'Save is hidden')!
    expect(save.extra).toMatchObject({ source: 'app', via: 'relay', from: 'Tess', url: `${site}/visits/3` })
    const logo = nodes.find((n) => n.title === 'Logo is blurry')!
    expect(logo.extra.url).toBeUndefined()
    expect(logo.body).not.toContain('elsewhere.example')

    // Built: the browser sees it ready to test, with its page and steps, and rejects it through the relay.
    await store.update(save.id, { proposed: '2026-11-13', built: '2026-11-13', body: `${save.body}\n## Thread\n\n**Claude** · 2026-11-13\nBigger button.\n\nTo test:\n1. Open a visit.\n2. Tap Save visit.\n` })
    await sync.tick()
    const ready = (await browser.status()).find((c) => c.id === save.id)!
    expect(ready).toMatchObject({ state: 'ready', steps: ['Open a visit.', 'Tap Save visit.'], web: { path: '/visits/3', text: 'Save is hidden' } })
    // A phone's comment has no page to go to.
    expect((await browser.status()).find((c) => c.id === logo.id)?.web).toBeUndefined()
    expect(await browser.tested(ready, false, 'Still hidden on small screens')).toBe('sent')
    await sync.tick()
    const back = await store.get(save.id)
    expect(back.extra.built).toBeUndefined()
    expect(back.body).toContain('Tested in the browser')
    expect(back.body).toContain('> Still hidden on small screens')
  })

  it('gives an open invite’s link again, until it is used', async () => {
    const r = await project()
    const sync = new RelaySync(r, ctx())
    const anna = await sync.invite('Anna')
    const bo = await sync.invite('Bo')
    expect(await sync.inviteAgain(anna.id)).toEqual({ id: anna.id, name: 'Anna', link: anna.link })
    expect((await sync.inviteAgain(bo.id))?.link).toBe(bo.link)
    expect(await sync.inviteAgain('f'.repeat(32))).toBeUndefined()
    // Used: no link any more.
    await phone(anna.link)
    await sync.tick()
    expect(await sync.inviteAgain(anna.id)).toBeUndefined()
  })
})

describe('the staging site the relay reports', () => {
  it('is believed only as an https origin, so nothing else reaches the terminal or the map', () => {
    expect(siteOrigin('https://staging.clinic.example/visits?x=1')).toBe('https://staging.clinic.example')
    expect(siteOrigin('http://staging.clinic.example')).toBe('')
    expect(siteOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(siteOrigin('https://user:pw@staging.clinic.example')).toBe('')
    expect(siteOrigin('\u001b]8;;https://evil\u0007click')).toBe('')
    expect(siteOrigin('javascript:alert(1)')).toBe('')
  })
})

interface BrowserRelay {
  join(link: string): Promise<string>
  post(comment: object): Promise<string>
  allowed(): Promise<boolean>
  status(): Promise<{ id: string; state: string; web?: { path: string }; [k: string]: unknown }[]>
  tested(c: object, works: boolean, note: string): Promise<string>
}
