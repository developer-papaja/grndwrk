import { randomBytes } from 'node:crypto'
import { CursorGone, type Changes, PROTOCOL, type StoreClient } from './protocol.js'

/** One rule of docs/store-protocol.md, and whether this store keeps it. */
export interface CheckResult {
  rule: string
  ok: boolean
  detail?: string
}

const text = (s: string) => new TextEncoder().encode(s)
const words = (b: Uint8Array) => new TextDecoder().decode(b)
// The smallest PNG there is: a 1x1 transparent pixel.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))

/** Every change after the cursor, page after page, latest state per path. */
async function follow(store: StoreClient, since: string): Promise<Changes> {
  const all = new Map<string, Changes['changes'][number]>()
  let cursor = since
  for (let i = 0; i < 50; i++) {
    const page = await store.changes({ since: cursor })
    for (const c of page.changes) all.set(c.path, c)
    cursor = page.cursor
    if (!page.more) break
  }
  return { cursor, changes: [...all.values()] }
}

/**
 * Run the protocol's rules against a store, through its client. With `http`
 * (the address and token), also the rules only HTTP has: the token, a path
 * that is not allowed, a write without a condition, a picture that is none.
 * Writes only files under nodes/ whose ids start n_check, and removes them.
 */
export async function checkStore(store: StoreClient, http?: { url: string; token: string; fetcher?: typeof fetch }): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const rule = async (name: string, test: () => Promise<string | undefined>) => {
    try {
      const problem = await test()
      out.push(problem ? { rule: name, ok: false, detail: problem } : { rule: name, ok: true })
    } catch (err) {
      out.push({ rule: name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  const id = `n_check${randomBytes(4).toString('hex')}`
  const path = `nodes/${id}.md`
  const picture = `files/${id}/dot.png`
  let v1 = ''
  let v2 = ''
  let cursor = ''

  await rule('hello says protocol 1 and may write', async () => {
    const h = await store.hello()
    if (h.protocol !== PROTOCOL) return `protocol is ${h.protocol}`
    if (!h.writable) return 'writable is false: check with a token that may write'
  })
  await rule('changes without a cursor lists files and gives a cursor', async () => {
    const c = await store.changes({})
    cursor = c.cursor
    if (!cursor) return 'no cursor'
  })
  await rule('creates a file with If-None-Match: *', async () => {
    const w = await store.write(path, text('---\nid: x\n---\nFirst\n'), { type: 'text/markdown', create: true })
    if (!w.ok) return 'refused'
    v1 = w.version
  })
  await rule('refuses to create a file that exists, and names its version', async () => {
    const w = await store.write(path, text('again'), { type: 'text/markdown', create: true })
    if (w.ok) return 'it overwrote the file'
    if (w.version !== v1) return `412 should name version ${v1}, named ${w.version}`
  })
  await rule('reads the file back, with its version', async () => {
    const r = await store.read(path)
    if (!r) return 'not found'
    if (words(r.bytes) !== '---\nid: x\n---\nFirst\n') return 'the bytes differ from what was written'
    if (r.version !== v1) return `version ${r.version}, expected ${v1}`
  })
  await rule('replaces a file with If-Match, and gives a new version', async () => {
    const w = await store.write(path, text('---\nid: x\n---\nSecond\n'), { type: 'text/markdown', ifVersion: v1 })
    if (!w.ok) return 'refused'
    if (w.version === v1) return 'the version did not change'
    v2 = w.version
  })
  await rule('refuses a write from an old version, and names the current one', async () => {
    const w = await store.write(path, text('stale'), { type: 'text/markdown', ifVersion: v1 })
    if (w.ok) return 'it took a write from a version that was replaced: someone loses their words'
    if (w.version !== v2) return `412 should name version ${v2}`
    const r = await store.read(path)
    if (r && words(r.bytes) === 'stale') return 'it refused, but wrote it anyway'
  })
  await rule('keeps a PNG picture', async () => {
    const w = await store.write(picture, PNG, { type: 'image/png', create: true })
    if (!w.ok) return 'refused'
    const r = await store.read(picture)
    if (!r || r.bytes.length !== PNG.length) return 'the picture did not come back the same'
  })
  await rule('lists what changed since the cursor', async () => {
    const c = await follow(store, cursor)
    const mine = c.changes.find((x) => x.path === path)
    if (!mine) return `${path} is not among the changes`
    if (mine.version !== v2) return `changes names version ${mine.version}, the file has ${v2}`
    if (!c.changes.some((x) => x.path === picture)) return 'the picture is not among the changes'
    cursor = c.cursor
  })
  await rule('refuses to delete an old version', async () => {
    const r = await store.remove(path, v1)
    if (r.ok) return 'it deleted a file someone had changed'
  })
  await rule('deletes with the current version, and the file is gone', async () => {
    const r = await store.remove(path, v2)
    if (!r.ok) return 'refused'
    if (await store.read(path)) return 'it can still be read'
  })
  await rule('lists the deletion as a change', async () => {
    const c = await follow(store, cursor)
    if (!c.changes.some((x) => x.path === path && x.deleted)) return 'no change with deleted: true'
  })
  await rule('answers an unknown cursor with 410', async () => {
    try {
      await store.changes({ since: 'not-a-cursor-this-store-gave' })
      return 'it answered as if the cursor were fine'
    } catch (err) {
      if (!(err instanceof CursorGone)) throw err
    }
  })

  if (http) {
    // Never after a redirect: the token goes to the store it was given for, as in HttpStore.
    const f = (input: URL, init: RequestInit = {}) => (http.fetcher ?? fetch)(input, { ...init, redirect: 'error' })
    const at = (p: string) => new URL(p, http.url.replace(/\/?$/, '/'))
    const auth = { Authorization: `Bearer ${http.token}` }
    await rule('refuses a request without a token (401)', async () => {
      const res = await f(at('v1/hello'))
      if (res.status !== 401) return `answered ${res.status}`
    })
    await rule('refuses a path that is not synced (400)', async () => {
      const res = await f(at('v1/files/local.json'), { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: '{}' })
      if (res.status !== 400) return `answered ${res.status}`
    })
    await rule('refuses a path that climbs out (400 or 404)', async () => {
      const res = await f(at('v1/files/nodes/%2e%2e/%2e%2e/secret.md'), { headers: auth })
      if (res.status !== 400 && res.status !== 404) return `answered ${res.status}`
    })
    await rule('refuses a write without If-Match or If-None-Match (428)', async () => {
      const res = await f(at(`v1/files/nodes/${id}b.md`), { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/markdown' }, body: 'x' })
      if (res.status !== 428) return `answered ${res.status}`
    })
    await rule('refuses a picture that is not one (415)', async () => {
      const res = await f(at(`v1/files/files/${id}/fake.png`), { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png', 'If-None-Match': '*' }, body: '<svg onload=alert(1)>' })
      if (res.status !== 415) return `answered ${res.status}`
    })
  } else {
    await rule('refuses a path that is not synced', async () => {
      try {
        const w = await store.write('local.json', text('{}'), { type: 'application/json', create: true })
        if (w.ok) return 'it wrote local.json'
      } catch {
        // Refused: right.
      }
    })
    await rule('refuses a picture that is not one', async () => {
      try {
        const w = await store.write(`files/${id}/fake.png`, text('<svg onload=alert(1)>'), { type: 'image/png', create: true })
        if (w.ok) return 'it kept it'
      } catch {
        // Refused: right.
      }
    })
  }

  // Clean up, whatever happened above.
  for (const p of [picture, path]) {
    const r = await store.read(p).catch(() => null)
    if (r) await store.remove(p, r.version).catch(() => {})
  }
  return out
}
