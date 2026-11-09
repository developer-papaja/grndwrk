import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { changeOwnEntry, readEntryFiles, removeOwnEntry } from '../src/store/threads.js'
import { appendAnswer, appendEntry, questions, splitAnswer, answerText, splitBody, withoutMeta } from '../src/shared/thread.js'
import { handleApi } from '../src/server/api.js'
import { NodeSync } from '../src/server/events.js'

let root: string
let gw: string
let store: NodeStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-answer-'))
  // Named .grndwrk, so links inside it are refused as in a real project.
  gw = join(root, '.grndwrk')
  await mkdir(gw)
  store = new NodeStore(gw)
})
afterEach(() => rm(root, { recursive: true, force: true }))

const runs = async (id: string) => (await readdir(join(gw, 'threads', id)).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort().map((f) => f.slice(0, -3))
const entryFile = (id: string, run: string) => readFile(join(gw, 'threads', id, `${run}.md`), 'utf8')

/** A thought with a question from Claude and the person's answer to it, each a file of its own. */
async function answered(answer = 'Today') {
  const n = (await store.create({ title: 'Booking' })).upserted[0]
  const asked = (await store.update(n.id, { body: appendEntry('', 'claude-asks', 'Which day comes first?', '2026-11-08') })).upserted[0]
  const q = questions(asked.body)[0]
  const done = (await store.update(n.id, { body: appendAnswer(asked.body, q, answer, '2026-11-09') })).upserted[0]
  const [, run] = await runs(n.id)
  return { id: n.id, run, body: done.body }
}

describe('the map knows each entry file', () => {
  it('carries the run on the entry, and keeps the date clean', async () => {
    const { id, run } = await answered()
    const entries = splitBody((await store.get(id)).body).entries
    expect(entries[1]).toMatchObject({ who: 'you', date: '2026-11-09', run })
    expect(entries[0].run).toMatch(/^\d{13}-[a-z0-9]{2}$/)
  })
})

describe('undo an answer', () => {
  it('deletes the entry just written, and the question is open again', async () => {
    const { id, run } = await answered()
    await removeOwnEntry(gw, id, run, '> Which day comes first?\n\nToday')
    expect(await runs(id)).toHaveLength(1)
    expect(questions((await store.get(id)).body)[0].open).toBe(true)
  })

  it('refuses when the answer changed since, or when it is not the person’s own', async () => {
    const { id, run } = await answered()
    await expect(removeOwnEntry(gw, id, run, 'Something else')).rejects.toThrow(/changed since/)
    const [asked] = await runs(id)
    await expect(removeOwnEntry(gw, id, asked)).rejects.toThrow(/your own/)
    await expect(removeOwnEntry(gw, id, '../../nodes/x')).rejects.toThrow(/Not an entry/)
    expect(await runs(id)).toHaveLength(2)
  })

  it('never follows a linked thread folder', async () => {
    const { id, run } = await answered()
    const elsewhere = await mkdtemp(join(tmpdir(), 'gw-elsewhere-'))
    try {
      await writeFile(join(elsewhere, `${run}.md`), '---\nwho: you\ndate: 2026-11-09\n---\nHi\n')
      await rm(join(gw, 'threads', id), { recursive: true })
      await symlink(elsewhere, join(gw, 'threads', id))
      await expect(removeOwnEntry(gw, id, run)).rejects.toThrow()
      expect(await readdir(elsewhere)).toEqual([`${run}.md`])
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('change an answer', () => {
  it('keep: a new entry replaces the old one, which stays and answers nothing', async () => {
    const { id, run } = await answered()
    const newer = await changeOwnEntry(gw, id, run, 'Tomorrow', true, new Date('2026-11-10T09:00:00Z'))
    expect(await entryFile(id, run)).toContain('Today')
    expect(await entryFile(id, newer)).toBe(`---\nwho: you\ndate: 2026-11-10\nreplaces: ${run}\nchanged: 2026-11-10T09:00:00Z\n---\n> Which day comes first?\n\nTomorrow\n`)
    const body = (await store.get(id)).body
    const entries = splitBody(body).entries
    expect(entries.map((e) => [e.who, !!e.superseded])).toEqual([['claude-asks', false], ['you', true], ['you', false]])
    expect(questions(body)[0]).toMatchObject({ open: false, answer: 'Tomorrow' })
    await expect(changeOwnEntry(gw, id, run, 'Again', true)).rejects.toThrow(/newer one/)
  })

  it('overwrite: rewrites the entry in place, keeping its question', async () => {
    const { id, run } = await answered()
    expect(await changeOwnEntry(gw, id, run, 'Tomorrow', false, new Date('2026-11-10T09:00:00Z'))).toBe(run)
    expect(await runs(id)).toHaveLength(2)
    expect(await entryFile(id, run)).toBe('---\nwho: you\ndate: 2026-11-09\nchanged: 2026-11-10T09:00:00Z\n---\n> Which day comes first?\n\nTomorrow\n')
    expect(questions((await store.get(id)).body)[0].answer).toBe('Tomorrow')
  })

  it('marks an answer Claude already acted on, until Claude takes it up', async () => {
    const { id, run } = await answered()
    const after = (await store.get(id)).body
    await store.update(id, { body: appendEntry(after, 'claude', 'Booked for today.', '2026-11-09') })
    const newer = await changeOwnEntry(gw, id, run, 'Tomorrow', true, new Date('2026-11-10T09:00:00Z'))
    expect(await entryFile(id, newer)).toContain('after_claude: true')
    let body = (await store.get(id)).body
    // The changed answer answers the question again, though Claude moved on before.
    expect(questions(body)[0]).toMatchObject({ open: false, answer: 'Tomorrow' })
    expect(splitBody(body).entries.at(-1)).toMatchObject({ afterClaude: true, retake: true })
    // Claude takes it up: an entry naming it.
    const ack = `${Date.parse('2026-11-10T10:00:00Z')}-ab`
    await writeFile(join(gw, 'threads', id, `${ack}.md`), `---\nwho: claude\ndate: 2026-11-10\ntakes_up: ${newer}\n---\nMoved it to tomorrow.\n`)
    body = (await store.get(id)).body
    const changed = splitBody(body).entries.find((e) => e.run === newer)
    expect(changed).toMatchObject({ afterClaude: true })
    expect(changed?.retake).toBeUndefined()
  })

  it('overwritten after Claude read it is marked too', async () => {
    const { id, run } = await answered()
    await store.update(id, { body: appendEntry((await store.get(id)).body, 'claude-asks', 'And the time?', '2026-11-09') })
    await changeOwnEntry(gw, id, run, 'Tomorrow', false)
    expect(await entryFile(id, run)).toContain('after_claude: true')
  })

  it('saving notes keeps the entry files, and what the map carries on entry lines never lands in the card', async () => {
    const { id } = await answered()
    const body = (await store.get(id)).body
    await store.update(id, { body: body.replace('## Thread', 'New notes\n\n## Thread') })
    const card = await readFile(join(gw, 'nodes', `${id}.md`), 'utf8')
    expect(card).toContain('New notes')
    expect(card).not.toContain('<!--')
    expect(await runs(id)).toHaveLength(2)
  })
})

describe('thread parsing', () => {
  const head = (who: string, date: string, meta = '') => `**${who}** · ${date}${meta}`
  it('a superseded answer does not count; the newer one answers the same quoted question', () => {
    const body = [
      '## Thread',
      '',
      head('Claude asks', '2026-11-08', ' <!-- run: 1762600000000-aa -->'),
      'Which day comes first?',
      '',
      head('You', '2026-11-09', ' <!-- run: 1762700000000-bb -->'),
      '> Which day comes first?',
      '',
      'Today',
      '',
      head('Claude', '2026-11-09', ' <!-- run: 1762700001000-cc -->'),
      'Booked.',
      '',
      head('You', '2026-11-10', ' <!-- run: 1762800000000-dd; replaces: 1762700000000-bb; changed: 2026-11-10T09:00:00Z; after_claude: true -->'),
      '> Which day comes first?',
      '',
      'Tomorrow',
      '',
    ].join('\n')
    const entries = splitBody(body).entries
    expect(entries[1]).toMatchObject({ date: '2026-11-09', superseded: true })
    expect(entries[3]).toMatchObject({ date: '2026-11-10', replaces: '1762700000000-bb', afterClaude: true, retake: true })
    expect(questions(body)).toMatchObject([{ open: false, answer: 'Tomorrow' }])
  })

  it('an unquoted superseded entry from before remarks answers nothing', () => {
    const body = `## Thread\n\n${head('Claude asks', '2026-10-01')}\nWhy?\n\n${head('You', '2026-10-02', ' <!-- run: 1762700000000-bb -->')}\nBecause\n\n${head('You', '2026-11-10', ' <!-- run: 1762800000000-dd; replaces: 1762700000000-bb -->')}\nA remark\n`
    expect(questions(body)[0].open).toBe(true)
  })

  it('what the map carries on entry lines can be stripped for a plain file', () => {
    expect(withoutMeta(`## Thread\n\n${head('You', '2026-11-09', ' <!-- run: 1762700000000-bb -->')}\nToday\n`)).toBe('## Thread\n\n**You** · 2026-11-09\nToday\n')
  })

  it('puts picked options and words back apart', () => {
    const options = ['Today', 'The last day booked', 'Never']
    for (const [picked, words] of [[['Today'], ''], [['Today', 'Never'], 'Whichever is later.'], [[], 'My own'], [['The last day booked'], 'And more\n\nlines']] as const) {
      expect(splitAnswer(options, answerText(options, [...picked], words))).toEqual({ picked: [...picked], words })
    }
  })
})

describe('the API', () => {
  let server: Server
  let base: string
  beforeEach(async () => {
    const nodes = new NodeSync(() => store.list())
    server = createServer((req, res) => void handleApi(req, res, { gwDir: gw, store, nodes }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  const call = (method: string, path: string, body: unknown) =>
    fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('takes back an answer and returns the thought', async () => {
    const { id, run } = await answered()
    const res = await call('POST', `/api/threads/${id}/${run}/undo`, { text: '> Which day comes first?\n\nToday' })
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.kind).toBe('node')
    expect(questions(out.item.body)[0].open).toBe(true)
  })

  it('changes an answer, and refuses Claude’s entries, unknown owners and bad runs', async () => {
    const { id, run } = await answered()
    const res = await call('PATCH', `/api/threads/${id}/${run}`, { text: 'Tomorrow', keep: true })
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.run).not.toBe(run)
    expect(questions(out.item.body)[0].answer).toBe('Tomorrow')
    const [asked] = await runs(id)
    expect((await call('PATCH', `/api/threads/${id}/${asked}`, { text: 'Hacked' })).status).toBe(409)
    expect((await call('PATCH', `/api/threads/n_nothere/${run}`, { text: 'x' })).status).toBe(404)
    expect((await call('PATCH', `/api/threads/${id}/..%2F${run}`, { text: 'x' })).status).toBe(404)
    expect((await readEntryFiles(gw, id)).find((e) => e.file === `${asked}.md`)?.text).toBe('Which day comes first?')
  })
})

