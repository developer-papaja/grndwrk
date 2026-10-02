import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore, ReadOnly } from '../src/store/nodes.js'

let root: string
let store: NodeStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
  await mkdir(join(root, 'nodes'))
  store = new NodeStore(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

const file = (id: string) => readFile(join(root, 'nodes', `${id}.md`), 'utf8')

describe('NodeStore', () => {
  it('creates a node from a title alone', async () => {
    const { upserted } = await store.create({ title: 'Booking should feel like texting' })
    const n = upserted[0]
    expect(n.id).toMatch(/^n_[a-z0-9]{4}$/)
    expect(await file(n.id)).toMatch(/^---\nid: n_\w{4}\ntype: idea\ntitle: Booking should feel like texting\naltitude: 3\nlinks: \[\]\nstatus: open\ncreated: \d{4}-\d{2}-\d{2}\n---\n$/)
  })

  it('rejects an empty title', async () => {
    await expect(store.create({ title: '  ' })).rejects.toThrow()
  })

  it('writes links on both nodes and removes them on both', async () => {
    const a = (await store.create({ title: 'A' })).upserted[0]
    const b = (await store.create({ title: 'B' })).upserted[0]
    const change = await store.update(a.id, { links: [b.id] })
    expect(change.upserted.map((n) => n.id).sort()).toEqual([a.id, b.id].sort())
    expect(await file(a.id)).toContain(`links: [${b.id}]`)
    expect(await file(b.id)).toContain(`links: [${a.id}]`)

    await store.update(b.id, { links: [] })
    expect(await file(a.id)).toContain('links: []')
    expect(await file(b.id)).toContain('links: []')
  })

  it('treats a one sided link as two sided and repairs it on write', async () => {
    const a = (await store.create({ title: 'A' })).upserted[0]
    const b = (await store.create({ title: 'B' })).upserted[0]
    // Hand edit: only B lists A.
    await writeFile(join(root, 'nodes', `${b.id}.md`), (await file(b.id)).replace('links: []', `links: [${a.id}]`))
    expect((await store.get(a.id)).links).toEqual([b.id])
    await store.update(a.id, { title: 'A2' })
    expect(await file(a.id)).toContain(`links: [${b.id}]`)
  })

  it('removes a deleted node from the nodes that linked to it', async () => {
    const a = (await store.create({ title: 'A' })).upserted[0]
    const b = (await store.create({ title: 'B', links: [a.id] })).upserted[0]
    const change = await store.delete(a.id)
    expect(change.deleted).toEqual([a.id])
    expect(await file(b.id)).toContain('links: []')
    expect((await store.list()).map((n) => n.id)).toEqual([b.id])
  })

  it('refuses to overwrite a file it cannot parse', async () => {
    await writeFile(join(root, 'nodes', 'n_bad1.md'), '---\ntitle: a: b\n---\nkeep me\n')
    const n = await store.get('n_bad1')
    expect(n.error).toBeTruthy()
    await expect(store.update('n_bad1', { title: 'x' })).rejects.toBeInstanceOf(ReadOnly)
    expect(await file('n_bad1')).toBe('---\ntitle: a: b\n---\nkeep me\n')
  })

  it('reports when each file last changed', async () => {
    const a = (await store.create({ title: 'A' })).upserted[0]
    const listed = await store.get(a.id)
    expect(Date.now() - Date.parse(listed.modified!)).toBeLessThan(5000)
    expect(await file(a.id)).not.toContain('modified')
  })

  it('sets and clears a topic', async () => {
    const a = (await store.create({ title: 'A', topic: ' navigation ' })).upserted[0]
    expect(a.topic).toBe('navigation')
    expect(await file(a.id)).toContain('title: A\ntopic: navigation\n')
    await store.update(a.id, { topic: '' })
    expect(await file(a.id)).not.toContain('topic:')
  })

  it('normalizes bad input instead of failing', async () => {
    const n = (await store.create({ title: 'x', altitude: 12, type: 'nope' as never })).upserted[0]
    expect(n).toMatchObject({ altitude: 5, type: 'idea' })
  })
})
