import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { testedInMap } from '../src/server/feedback.js'
import { progressOfNode } from '../src/shared/progress.js'

let gw: string
let store: NodeStore
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-test-work-'))
  store = new NodeStore(gw)
})
afterEach(async () => rm(gw, { recursive: true, force: true }))

describe('testing work on any thought', () => {
  it('is ready to test once built, done when it works, back with the note when it does not', async () => {
    const change = await store.create({ title: 'Zoom in steps of 10 %', type: 'idea' })
    const id = change.upserted[0].id
    expect(progressOfNode((await store.get(id))!)).toBe('open')
    await expect(testedInMap(store, id, { works: true })).rejects.toThrow(/built/)

    await store.update(id, { built: '2026-11-09' })
    expect(progressOfNode((await store.get(id))!)).toBe('ready')
    expect(await testedInMap(store, id, { works: false, note: 'Step 2: Fit lands on 101 %' })).toBe('incoming')
    const back = (await store.get(id))!
    expect(back.extra.built).toBeUndefined()
    expect(progressOfNode(back)).toBe('open')
    expect(back.body).toContain('Tested on the Mac: does not work yet.')
    expect(back.body).toContain('What is still wrong:\n\n> Step 2: Fit lands on 101 %')

    // A picture in the note goes below the quote, on a line of its own.
    await store.update(id, { built: '2026-11-09' })
    await testedInMap(store, id, { works: false, note: 'Still off\n![](../files/' + id + '/1794232221404.png)' })
    const pic = (await store.get(id))!.body
    expect(pic).toContain('> Still off\n\n![](../files/' + id + '/1794232221404.png)')
    expect(pic).not.toContain('> ![')

    await store.update(id, { built: '2026-11-10' })
    expect(await testedInMap(store, id, { works: true })).toBe('fixed')
    const done = (await store.get(id))!
    expect(done.status).toBe('settled')
    expect(progressOfNode(done)).toBe('done')
    await expect(testedInMap(store, id, { works: true })).rejects.toThrow(/built/)
  })
})
