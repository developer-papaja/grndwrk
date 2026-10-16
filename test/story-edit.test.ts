import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStory, listStories, updateStory } from '../src/store/stories.js'
import { criteriaOf, storyStatusLabel, tickCriterion } from '../src/shared/story.js'
import { progressOfNode, progressOfStory, showsProgress } from '../src/shared/progress.js'
import type { GNode, Story } from '../src/shared/types.js'

let gw: string
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-story-'))
  await mkdir(join(gw, 'stories'))
})
afterEach(() => rm(gw, { recursive: true, force: true }))

const STORY = '---\nid: s_k3f9\ntitle: Book a desk\nstatus: not-started\nfrom: [n_2a9d]\napplies_to: []\ncreated: 2026-10-03\nowner: someone\n---\nAs someone, I want a desk.\n\n## Acceptance\n- Three steps at most\n- [x] The desk shows\n- [ ] A receipt is sent\n'

describe('acceptance criteria', () => {
  it('reads ticked, open and plain criteria, and ticks one', () => {
    const c = criteriaOf(STORY.split('---\n')[2])
    expect(c.map((x) => [x.text, x.met])).toEqual([['Three steps at most', false], ['The desk shows', true], ['A receipt is sent', false]])
    const body = tickCriterion(STORY.split('---\n')[2], c[0].line, true)
    expect(body).toContain('- [x] Three steps at most')
  })

  it('says how many criteria are met instead of a bare "partial"', () => {
    const body = STORY.split('---\n')[2]
    expect(storyStatusLabel({ status: 'partial', body })).toBe('1 of 3 criteria met')
    expect(storyStatusLabel({ status: 'partial', body: 'No criteria.' })).toBe('Partially done')
    expect(storyStatusLabel({ status: 'done', body })).toBe('Done')
    expect(storyStatusLabel({ status: 'not-started', body: 'x' })).toBe('Not started')
  })
})

describe('stories changed in the map', () => {
  it('changes only the lines that changed, and keeps fields it does not know', async () => {
    await writeFile(join(gw, 'stories', 's_k3f9.md'), STORY)
    await updateStory(gw, 's_k3f9', { status: 'partial', later: '2026-10-15' })
    const raw = await readFile(join(gw, 'stories', 's_k3f9.md'), 'utf8')
    expect(raw).toBe(STORY.replace('status: not-started', 'status: partial').replace('owner: someone\n', 'owner: someone\nlater: 2026-10-15\n'))
    const back = await updateStory(gw, 's_k3f9', { later: null, title: 'Book a desk: fast' })
    expect(back?.later).toBeUndefined()
    expect(back?.title).toBe('Book a desk: fast')
    expect(await readFile(join(gw, 'stories', 's_k3f9.md'), 'utf8')).toContain('title: "Book a desk: fast"')
    await expect(updateStory(gw, 's_k3f9', { status: 'finished' })).rejects.toThrow()
  })

  it('writes a new story from a thought, with checkboxes to fill in', async () => {
    const st = await createStory(gw, { title: 'Pick a desk on the plan', from: ['n_2a9d'] })
    expect(st.id).toMatch(/^s_[a-z0-9]{6}$/)
    expect((await listStories(gw)).map((s) => [s.title, s.status, s.from])).toEqual([['Pick a desk on the plan', 'not-started', ['n_2a9d']]])
    expect(st.body).toContain('## Acceptance\n- [ ] ')
    await expect(createStory(gw, { title: 'No source', from: [] })).rejects.toThrow()
  })
})

describe('one set of statuses for everything on the map', () => {
  const node = (extra: Partial<GNode>) => ({ id: 'n_a', title: 'x', type: 'idea', status: 'open', links: [], body: '', extra: {}, ...extra }) as GNode
  it('reads comments, stories and thoughts the same way, and hides what is finished', () => {
    expect(progressOfNode(node({ extra: { source: 'app' } }))).toBe('open')
    expect(progressOfNode(node({ extra: { source: 'app', proposed: '2026-10-14' } }))).toBe('in-progress')
    expect(progressOfNode(node({ extra: { source: 'app', built: '2026-10-14' } }))).toBe('ready')
    expect(progressOfNode(node({ extra: { source: 'app', fixed: '2026-10-14' } }))).toBe('done')
    expect(progressOfNode(node({ status: 'settled' }))).toBe('done')
    expect(progressOfNode(node({ status: 'parked' }))).toBe('later')
    const story = (s: Partial<Story>) => ({ id: 's_a', title: 'x', status: 'not-started', from: [], applies_to: [], created: '', body: '', ...s }) as Story
    expect(progressOfStory(story({ status: 'partial' }))).toBe('in-progress')
    expect(progressOfStory(story({ status: 'partial', later: '2026-10-15' }))).toBe('later')
    expect(['open', 'in-progress', 'ready', 'done', 'later'].map((p) => showsProgress('', p as never))).toEqual([true, true, true, false, false])
    expect(showsProgress('done', 'done')).toBe(true)
    expect(showsProgress('all', 'later')).toBe(true)
  })
  it('quotes a title YAML would misread, and replaces a title written over several lines', async () => {
    await writeFile(join(gw, 'stories', 's_k3f9.md'), STORY.replace('title: Book a desk', 'title: |\n  Book a desk\n  in three steps'))
    await updateStory(gw, 's_k3f9', { title: 'null' })
    expect((await listStories(gw))[0].title).toBe('null')
    await updateStory(gw, 's_k3f9', { title: '1e3' })
    const story = (await listStories(gw))[0]
    expect(story.title).toBe('1e3')
    const file = await readFile(join(gw, 'stories', 's_k3f9.md'), 'utf8')
    expect(file).not.toContain('in three steps')
    expect(file).toContain('owner: someone')
  })
})
