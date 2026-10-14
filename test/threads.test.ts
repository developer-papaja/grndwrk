import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { listScreens, updateScreen } from '../src/store/screens.js'
import { appendEntry, questions, splitBody } from '../src/shared/thread.js'

let gw: string
let store: NodeStore
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-threads-'))
  store = new NodeStore(gw)
})
afterEach(() => rm(gw, { recursive: true, force: true }))

const entryFiles = async (id: string) => (await readdir(join(gw, 'threads', id)).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))

describe('thread entries in files of their own', () => {
  it('writes an answer as a new file and leaves the card file as it was', async () => {
    const n = (await store.create({ title: 'Booking', body: 'Notes.\n\n## Thread\n\n**Claude asks** · 2026-10-13\nWhich day?\n' })).upserted[0]
    const cardBefore = await readFile(join(gw, 'nodes', `${n.id}.md`), 'utf8')
    const answered = (await store.update(n.id, { body: appendEntry(n.body, 'you', 'Today', '2026-10-14') })).upserted[0]
    expect(await readFile(join(gw, 'nodes', `${n.id}.md`), 'utf8')).toBe(cardBefore)
    const files = await entryFiles(n.id)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{13}-[a-z0-9]{2}\.md$/)
    expect(await readFile(join(gw, 'threads', n.id, files[0]), 'utf8')).toBe('---\nwho: you\ndate: 2026-10-14\n---\nToday\n')
    // The map sees one thread, the old entry and the new one, and the question answered.
    expect(splitBody(answered.body).entries.map((e) => [e.who, e.text])).toEqual([['claude-asks', 'Which day?'], ['you', 'Today']])
    expect(questions(answered.body)[0].open).toBe(false)
  })

  it('keeps entry files when the notes change, and writes the notes into the card', async () => {
    const n = (await store.create({ title: 'A' })).upserted[0]
    const asked = (await store.update(n.id, { body: appendEntry('', 'claude-asks', 'Why?', '2026-10-14') })).upserted[0]
    const edited = (await store.update(n.id, { body: `New notes\n\n${asked.body.slice(asked.body.indexOf('## Thread'))}` })).upserted[0]
    expect(await readFile(join(gw, 'nodes', `${n.id}.md`), 'utf8')).toContain('New notes')
    expect(await readFile(join(gw, 'nodes', `${n.id}.md`), 'utf8')).not.toContain('Why?')
    expect(splitBody(edited.body)).toMatchObject({ notes: 'New notes', entries: [{ who: 'claude-asks', text: 'Why?' }] })
    expect(await entryFiles(n.id)).toHaveLength(1)
  })

  it('reads entry files someone else added, in date order, and drops them with the card', async () => {
    const n = (await store.create({ title: 'A', body: '## Thread\n\n**Claude asks** · 2026-10-12\nFirst?\n' })).upserted[0]
    await mkdir(join(gw, 'threads', n.id), { recursive: true })
    await writeFile(join(gw, 'threads', n.id, '1792000000000-ab.md'), '---\nwho: you\ndate: 2026-10-13\n---\nYes.\n')
    await writeFile(join(gw, 'threads', n.id, '1792000000500-cd.md'), '---\nwho: claude-asks\ndate: 2026-10-14\n---\nAnd second?\n')
    const read = await store.get(n.id)
    expect(splitBody(read.body).entries.map((e) => e.text)).toEqual(['First?', 'Yes.', 'And second?'])
    expect(questions(read.body).filter((q) => q.open).map((q) => q.question)).toEqual(['And second?'])
    await store.delete(n.id)
    expect(await entryFiles(n.id)).toEqual([])
  })

  it('does the same for a screen', async () => {
    await mkdir(join(gw, 'screens'), { recursive: true })
    await writeFile(join(gw, 'screens', 'p_home.md'), '---\nid: p_home\ntitle: Home\n---\nWhat is on it.\n\n## Thread\n\n**Claude asks** · 2026-10-14\nWho is it for?\n')
    const [screen] = await listScreens(gw)
    const before = await readFile(join(gw, 'screens', 'p_home.md'), 'utf8')
    const after = await updateScreen(gw, 'p_home', { body: appendEntry(screen.body, 'you', 'Everyone at the office', '2026-10-14') })
    expect(await readFile(join(gw, 'screens', 'p_home.md'), 'utf8')).toBe(before)
    expect(splitBody(after!.body).entries.map((e) => e.who)).toEqual(['claude-asks', 'you'])
    expect(splitBody((await listScreens(gw))[0].body).entries).toHaveLength(2)
  })
})
