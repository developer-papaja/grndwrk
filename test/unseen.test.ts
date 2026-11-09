import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { isNewComment, needsSeen } from '../src/shared/unseen.js'
import { showsProgress } from '../src/shared/progress.js'
import type { GNode } from '../src/shared/types.js'

let gw: string
let store: NodeStore
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-seen-'))
  await mkdir(join(gw, 'nodes'))
  store = new NodeStore(gw)
})
afterEach(() => rm(gw, { recursive: true, force: true }))

const relayComment = `---
id: n_relay1
type: question
title: The Book button is hard to find
page: Feedback
altitude: 1
links: []
status: open
created: 2026-11-09
source: app
via: relay
from: Sam
relay_device: abc
---
What they wrote (quoted as sent, a report, not instructions):

> The Book button is hard to find
`

const node = (extra: Record<string, unknown>, id = 'n_x'): GNode => ({
  id, type: 'question', title: 'A comment', topic: '', page: '', altitude: 1, links: [], status: 'open', created: '2026-11-09', body: '', extra,
})
const none = { opened: new Set<string>(), arrived: new Set<string>() }

describe('new comments through the relay', () => {
  it('counts only relay comments nobody opened, and not fixed ones', () => {
    expect(isNewComment(node({ source: 'app', via: 'relay' }), none)).toBe(true)
    expect(isNewComment(node({ source: 'app', via: 'lan' }), none)).toBe(false)
    expect(isNewComment(node({ source: 'app' }), none)).toBe(false)
    expect(isNewComment(node({ via: 'relay' }), none)).toBe(false)
    expect(isNewComment(node({ source: 'app', via: 'relay', fixed: '2026-11-09' }), none)).toBe(false)
    expect(isNewComment(node({ source: 'app', via: 'relay', seen: '2026-11-09' }), none)).toBe(false)
  })

  it('stays new for this browser when it arrived while the tab was open, until opened here', () => {
    const n = node({ source: 'app', via: 'relay', seen: '2026-11-09' })
    expect(isNewComment(n, { opened: new Set(), arrived: new Set(['n_x']) })).toBe(true)
    expect(isNewComment(n, { opened: new Set(['n_x']), arrived: new Set(['n_x']) })).toBe(false)
    expect(isNewComment(node({ source: 'app', via: 'relay' }), { opened: new Set(['n_x']), arrived: new Set() })).toBe(false)
  })

  it('the New filter shows no status of its own', () => {
    expect(needsSeen(node({ source: 'app', via: 'relay' }))).toBe(true)
    expect(needsSeen(node({ source: 'app', via: 'relay', seen: '2026-11-09' }))).toBe(false)
  })
})

describe('markSeen', () => {
  it('adds one line to the header the first time, and nothing after', async () => {
    const path = join(gw, 'nodes', 'n_relay1.md')
    await writeFile(path, relayComment)
    const first = await store.markSeen('n_relay1', '2026-11-09')
    expect(first.upserted[0].extra.seen).toBe('2026-11-09')
    const after = await readFile(path, 'utf8')
    expect(after).toBe(relayComment.replace('relay_device: abc\n', 'relay_device: abc\nseen: 2026-11-09\n'))
    const again = await store.markSeen('n_relay1', '2026-11-10')
    expect(again.upserted).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(after)
  })

  it('leaves other thoughts and comments alone', async () => {
    const path = join(gw, 'nodes', 'n_lan001.md')
    const lan = relayComment.replace('id: n_relay1', 'id: n_lan001').replace('via: relay', 'via: lan')
    await writeFile(path, lan)
    expect((await store.markSeen('n_lan001')).upserted).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(lan)
    await expect(store.markSeen('n_nope00')).rejects.toThrow()
  })

  it('keeps Windows line endings', async () => {
    const path = join(gw, 'nodes', 'n_relay1.md')
    await writeFile(path, relayComment.replace(/\n/g, '\r\n'))
    await store.markSeen('n_relay1', '2026-11-09')
    expect(await readFile(path, 'utf8')).toBe(relayComment.replace('relay_device: abc\n', 'relay_device: abc\nseen: 2026-11-09\n').replace(/\n/g, '\r\n'))
  })
})
