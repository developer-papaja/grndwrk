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
import { parseLink, projectRelay, saveProjectRelay, teamLink, type ProjectRelay } from '../src/relay/config.js'
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
})
