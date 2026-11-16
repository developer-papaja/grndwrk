/**
 * The page on a store: the same calls as api.ts, answered in the browser from
 * the team's store (docs/store-protocol.md) instead of grndwrk on a Mac. The
 * page's build (`vite build --mode page`) puts this module where api.ts was.
 *
 * The whole map is read once (`changes` without a cursor, then each file),
 * kept in memory (page/vfs.ts), and kept live by asking for `changes` after
 * the last cursor, a long poll. Reading and writing it is done by the store
 * code grndwrk itself runs (src/store/*), over that memory, so a card, a
 * thread entry or a screen is parsed and written exactly as on the Mac. What
 * a change wrote goes to the store file by file with its condition: a new
 * file only if none is there (If-None-Match), a changed one only if nobody
 * changed it meanwhile (If-Match). When someone did, the change is undone
 * here, that file is read again, and the person is told plainly.
 *
 * The token lives in this tab's sessionStorage, per project, and only goes
 * to the store's own address in the Authorization header.
 */
import type { GNode, NodeInput, PairRequest, Persona, PersonaInSegment, PersonaList, PersonaSection, Screen, Segment, ServerEvent } from '../../src/shared/types'
import { HttpStore } from '../../src/shared-store/http'
import { CursorGone, isMapPath, isPicture, typeOf } from '../../src/shared-store/protocol'
import { NodeStore } from '../../src/store/nodes'
import { readProject, KICKOFF_STEPS, writeFields, writeKickoff, writePages } from '../../src/store/project'
import { removeFiles, saveImage } from '../../src/store/files'
import { markAnswered, readReadiness, setFocusLater as saveFocusLater } from '../../src/store/readiness'
import { createStory as saveNewStory, listStories, readDraft, readOutput, updateStory as saveStory } from '../../src/store/stories'
import { listScreens, updateScreen as saveScreen, type ScreenEdit } from '../../src/store/screens'
import { createPersona as saveNewPersona, deletePersona as dropPersona, listPersonas, settleAudienceName, updatePersona as savePersona } from '../../src/store/personas'
import { createSegment as saveNewSegment, deleteSegment as dropSegment, listSegments, updateSegment as saveSegment } from '../../src/store/segments'
import { changeOwnEntry, removeOwnEntry } from '../../src/store/threads'
import { readWaiting, setPersonalInfo, setWaiting } from '../../src/store/waiting'
import { today } from '../../src/store/frontmatter'
import { createView as saveNewView, deleteView as dropView, listViews, updateView as saveView } from '../../src/store/views'
import type { ViewSettings } from '../../src/shared/views'
import { overviewOf, type MapFiles, type ProjectOverview } from '../../src/shared/overview'
import * as vfs from './page/vfs'

/** The page, not grndwrk on a Mac: the one flag the UI reads to leave out what only works there. */
export const PAGE = true

export const OFFLINE_MESSAGE = "Can't reach the store. Check your connection; the page keeps trying."
const READ_ONLY = 'Your sign-in may read this map but not change it.'
const ON_MAC = 'That works in grndwrk on a Mac, not on this page.'

// Signing in

/** Who is signed in, for the sign-in screen and the read only note. */
export const session = {
  signedIn: false,
  /** Checking a token kept from before, so the sign-in screen does not flash. */
  checking: false,
  writable: false,
  /** The project's name, from the store. */
  project: '',
  /** The person's name, when the store says it (`hello.name`, not in the protocol yet). */
  name: '',
  /** Why the sign-in screen shows: a token not taken, or run out. */
  problem: '',
}
const listeners: (() => void)[] = []
export function onSession(f: () => void) {
  listeners.push(f)
}
const told = () => {
  for (const f of listeners) f()
}

let base = ''
let token = ''
let storage: Storage | null = null
const tokenKey = () => `grndwrk.token:${new URL(base).pathname}`

/** Where the store is and how to keep the token. The page works it out from its own address; tests set it. */
export function configure(o: { base: string; token?: string; storage?: Storage | null }) {
  base = new URL('./', o.base).toString()
  storage = o.storage ?? null
  token = o.token ?? read()
  session.checking = !!token
}

function read(): string {
  try {
    return storage?.getItem(tokenKey()) ?? ''
  } catch {
    return ''
  }
}

function keep(t: string) {
  try {
    if (t) storage?.setItem(tokenKey(), t)
    else storage?.removeItem(tokenKey())
  } catch {
    // Blocked storage: signed in for as long as this page is open.
  }
}

if (typeof location !== 'undefined') {
  let s: Storage | null = null
  try {
    s = sessionStorage
  } catch {
    // Storage is blocked: the token lasts as long as the page.
  }
  configure({ base: location.href, storage: s })
  // A store's own login may hand the token over once, in the address's fragment
  // (never sent to a server). Kept for this project in this tab, and taken out
  // of the address at once, so it is not in the history or a copied link.
  const handed = /(?:^#|&)token=([^&]+)/.exec(location.hash)
  if (handed) {
    history.replaceState(null, '', location.pathname + location.search)
    token = decodeURIComponent(handed[1])
    keep(token)
    session.checking = true
  }
}

let client: HttpStore | null = null
function store(): HttpStore {
  if (!client) {
    // Every answer passes here first: a 401 means the token is no longer good.
    const fetcher: typeof fetch = async (input, init) => {
      let res: Response
      try {
        res = await fetch(input, init)
      } catch {
        throw new Error(OFFLINE_MESSAGE)
      }
      if (res.status === 401 && session.signedIn) signedOut('Your sign-in ran out or was taken back. Sign in again.')
      return res
    }
    client = new HttpStore(base, token, fetcher)
  }
  return client
}

const waiters: (() => void)[] = []

/** Check a token with the store and keep it for this project. Returns why not, or '' when signed in. */
export async function signIn(t: string): Promise<string> {
  const next = t.trim()
  if (!next) return 'Paste the token your store gave you.'
  const done = (why: string) => {
    session.checking = false
    told()
    return why
  }
  let hello: Record<string, unknown>
  try {
    // Read here rather than through HttpStore.hello, which keeps only the protocol's fields: a store may also say who this is (`name`).
    const res = await fetch(new URL('v1/hello', base), { headers: { Authorization: `Bearer ${next}` }, redirect: 'error' }).catch(() => {
      throw new Error(OFFLINE_MESSAGE)
    })
    if (res.status === 401 || res.status === 403) return done('The store did not take that token. Check it, or ask for a new one.')
    hello = (await res.json().catch(() => null)) ?? {}
    if (!res.ok || hello.protocol !== 1) return done(`The store answered something unexpected (${res.status}). Is this the project's address?`)
  } catch (err) {
    return done(err instanceof Error ? err.message : String(err))
  }
  const role = hello.role === 'read' || hello.role === 'write' || hello.role === 'comment' ? hello.role : hello.writable === true ? 'write' : 'read'
  if (role === 'comment') return done('That token may only leave comments. The page needs one that may read the map.')
  token = next
  client = null
  keep(next)
  const project = typeof hello.project === 'string' ? hello.project.slice(0, 200) : ''
  Object.assign(session, { signedIn: true, checking: false, writable: role === 'write', project, problem: '', name: typeof hello.name === 'string' ? hello.name.slice(0, 80) : '' })
  told()
  for (const w of waiters.splice(0)) w()
  return ''
}

function signedOut(problem: string) {
  token = ''
  client = null
  keep('')
  Object.assign(session, { signedIn: false, checking: false, writable: false, problem })
  loaded = false
  vfs.clearAll()
  forgetPictures()
  told()
}

/** Forget the token here, and the map with it. */
export function signOut() {
  signedOut('')
}

// The map in memory, kept live

const ROOT = vfs.ROOT
const nodes = new NodeStore(ROOT)
let loaded = false
let cursor = ''
/** When this tab saw each card change, for "newest first" on the board. */
const changedAt = new Map<string, string>()

vfs.setLoader(async (path) => {
  const f = await store().read(path)
  return f ? { bytes: f.bytes, version: f.version } : null
})

/** Reads and changes, one at a time, so a change never sees half of another. */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

/** Bring the memory to what the store says: these paths, each at this version or gone. */
async function apply(changes: { path: string; version?: string; deleted?: boolean }[]): Promise<string[]> {
  const fetch: { path: string; version: string }[] = []
  const done: string[] = []
  for (const c of changes) {
    if (!isMapPath(c.path)) continue
    if (c.deleted) {
      if (vfs.storedVersion(c.path) !== null) {
        vfs.dropStored(c.path)
        done.push(c.path)
      }
    } else if (vfs.storedVersion(c.path) !== c.version) {
      // Pictures are read when shown; text is the map itself.
      if (isPicture(typeOf(c.path))) {
        vfs.putStored(c.path, null, c.version ?? '')
        done.push(c.path)
      } else fetch.push({ path: c.path, version: c.version ?? '' })
    }
  }
  // A few at a time: a map is hundreds of small files.
  for (let i = 0; i < fetch.length; i += 8) {
    await Promise.all(
      fetch.slice(i, i + 8).map(async ({ path }) => {
        const f = await store().read(path)
        if (f) vfs.putStored(path, f.bytes, f.version)
        else vfs.dropStored(path)
        done.push(path)
      }),
    )
  }
  return done
}

/** Everything the store has, compared with what this tab holds. */
async function loadAll(): Promise<string[]> {
  let page = await store().changes({})
  const all = [...page.changes]
  while (page.more) {
    page = await store().changes({ since: page.cursor })
    all.push(...page.changes)
  }
  cursor = page.cursor
  const there = new Set(all.filter((c) => !c.deleted).map((c) => c.path))
  const gone = vfs.storedPaths().filter((p) => !there.has(p)).map((path) => ({ path, deleted: true }))
  const done = await serial(() => apply([...gone, ...all]))
  loaded = true
  return done
}

let handlers: { onEvent: (event: ServerEvent) => void; onOpen: () => void; onError: () => void } | null = null
/** Cards as last told to the map, to tell it only what changed. */
let lastNodes = new Map<string, string>()

/** Tell the map what changed, as grndwrk's server events would. */
async function announce(paths: string[]) {
  if (!handlers || !paths.length) return
  const folders = new Set<string>()
  let cards = false
  for (const p of paths) {
    const [top, second] = p.split('/')
    if (top === 'nodes' || (top === 'threads' && second?.startsWith('n_'))) {
      cards = true
      const id = top === 'nodes' ? second.replace(/\.md$/, '') : second
      changedAt.set(id, new Date().toISOString())
    }
    // A screen's, persona's or segment's thread shows with it.
    if (top === 'threads' && second?.startsWith('p_')) folders.add('screens/')
    else if (top === 'threads' && (second?.startsWith('pe_') || second?.startsWith('sg_'))) folders.add('personas/')
    else if (top === 'segments') folders.add('personas/')
    else if (top === 'project.md') folders.add('project.md')
    else if (top === 'outputs') folders.add(`outputs/${second ?? ''}`)
    else if (top !== 'nodes' && top !== 'threads' && top !== 'files') folders.add(`${top}/`)
  }
  if (cards) {
    const now = await listNodes()
    const ids = new Set(now.map((n) => n.id))
    for (const n of now) {
      const json = JSON.stringify(n)
      if (lastNodes.get(n.id) !== json) handlers.onEvent({ type: 'node:upsert', node: n })
    }
    for (const id of lastNodes.keys()) if (!ids.has(id)) handlers.onEvent({ type: 'node:delete', id })
    lastNodes = new Map(now.map((n) => [n.id, JSON.stringify(n)]))
  }
  for (const path of folders) handlers.onEvent({ type: 'file:change', path })
}

let generation = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Stay live: the whole map once, then what changes, for as long as the page is in view. */
export function subscribe(h: { onEvent: (event: ServerEvent) => void; onOpen: () => void; onError: () => void }): { close(): void } {
  handlers = h
  const mine = ++generation
  void (async () => {
    let open = false
    let pause = 1000
    while (mine === generation) {
      try {
        if (!session.signedIn) {
          if (token && !session.problem) {
            const why = await signIn(token)
            // Offline is no reason to forget the token: try again shortly.
            if (why === OFFLINE_MESSAGE) throw new Error(why)
            if (why) signedOut(why)
            continue
          }
          await new Promise<void>((r) => waiters.push(r))
          continue
        }
        if (!loaded) {
          const done = await loadAll()
          if (open) await serial(() => announce(done))
        }
        if (!open) {
          open = true
          pause = 1000
          h.onOpen()
        }
        let page = await store().changes({ since: cursor, wait: 25 })
        if (mine !== generation) return
        const all = [...page.changes]
        while (page.more) {
          page = await store().changes({ since: page.cursor })
          all.push(...page.changes)
        }
        cursor = page.cursor
        await serial(async () => announce(await apply(all)))
      } catch (err) {
        if (mine !== generation) return
        // A cursor the store forgot: read everything again and compare.
        if (err instanceof CursorGone) {
          loaded = false
          continue
        }
        if (open) h.onError()
        open = false
        await sleep(pause)
        pause = Math.min(pause * 2, 30_000)
      }
    }
  })()
  return {
    close() {
      if (mine === generation) generation++
    },
  }
}

// Changing the map

/** Someone else changed a file between reading and writing it. */
class Conflict extends Error {
  constructor(readonly path: string) {
    super(path)
  }
}

function what(path: string): string {
  const [top, second] = path.split('/')
  if (top === 'threads') return second?.startsWith('p_') ? 'this screen' : second?.startsWith('pe_') ? 'this persona' : 'this conversation'
  return (
    {
      nodes: 'this thought',
      screens: 'this screen',
      stories: 'this story',
      personas: 'this persona',
      segments: 'this segment',
      'project.md': 'the project settings',
      waiting: 'this question',
      views: 'this view',
      readiness: 'the check',
      files: 'this picture',
    }[top] ?? path
  )
}

/** Make a change with the store code, then send what it wrote, each file on its condition. */
function change<T>(fn: () => Promise<T>): Promise<T> {
  return serial(async () => {
    if (!session.writable) throw new Error(READ_ONLY)
    vfs.begin()
    let out: T
    try {
      out = await fn()
    } catch (err) {
      vfs.end()
      vfs.undoLast()
      throw err
    }
    const ops = vfs.end()
    try {
      for (const op of ops) {
        const s = store()
        if (op.kind === 'remove') {
          const r = await s.remove(op.path, op.version)
          if (!r.ok && !('gone' in r)) throw new Conflict(op.path)
          vfs.confirmed(op.path, '')
        } else {
          const w = await s.write(op.path, op.bytes, { type: typeOf(op.path), ...(op.kind === 'create' ? { create: true } : { ifVersion: op.version }) })
          if (!w.ok) throw new Conflict(op.path)
          vfs.confirmed(op.path, w.version)
        }
      }
    } catch (err) {
      vfs.undoLast()
      if (err instanceof Conflict) {
        // Show what is there now, and say so plainly.
        const f = await store().read(err.path).catch(() => null)
        if (f) vfs.putStored(err.path, f.bytes, f.version)
        else vfs.dropStored(err.path)
        await announce([err.path, ...ops.map((o) => o.path)])
        throw new Error(`Someone changed ${what(err.path)} meanwhile, so yours was not saved. It shows their version now; make your change again.`)
      }
      await announce(ops.map((o) => o.path))
      const why = err instanceof Error ? err.message : String(err)
      if (/: 403\b/.test(why)) throw new Error(READ_ONLY)
      throw err
    }
    await announce(ops.map((o) => o.path))
    return out
  })
}

const look = <T>(fn: () => Promise<T>) => serial(fn)

/** The cards as the map shows them, with when each last changed as far as this page can tell. */
async function listNodes(): Promise<GNode[]> {
  const list = await nodes.list()
  // The store keeps no times: the newest of its creation, its thread entries and what this tab saw change.
  const entries = new Map<string, number>()
  for (const p of vfs.storedPaths()) {
    const m = /^threads\/(n_[^/]+)\/(\d{9,13})-/.exec(p)
    if (m) entries.set(m[1], Math.max(entries.get(m[1]) ?? 0, Number(m[2])))
  }
  for (const n of list) {
    const times = [Date.parse(n.created) || 0, entries.get(n.id) ?? 0, Date.parse(changedAt.get(n.id) ?? '') || 0]
    n.modified = new Date(Math.max(...times)).toISOString()
  }
  return list
}

// The calls the map makes, as in api.ts

export const fetchNodes = () =>
  look(async () => {
    const list = await listNodes()
    lastNodes = new Map(list.map((n) => [n.id, JSON.stringify(n)]))
    return list
  })
async function project() {
  const { data, body, pages } = await readProject(ROOT)
  return { ...data, body, pages, folder: session.project } as Record<string, unknown>
}
export const fetchProject = () => look(project).catch(() => ({}))
export const fetchStories = () => look(() => listStories(ROOT))
export interface DocFinding { id: string; title: string; status: string; missing: string[]; suggestion: string; section?: string }
export interface Doc { path: string; exists: boolean; findings: DocFinding[]; draft?: string; blocked?: string }
// The product's own documents are in its repository, not in the store.
export const fetchDocs = async () => [] as Doc[]
export const fetchDoc = async (_path: string): Promise<{ path: string; text: string; exists: boolean; draft?: string }> => {
  throw new Error(ON_MAC)
}
export const openDocInEditor = async (_path: string): Promise<{ opened: boolean }> => {
  throw new Error(ON_MAC)
}
export const createStory = (input: { title: string; from: string[]; body?: string }) => change(() => saveNewStory(ROOT, input))
export const updateStory = (id: string, edit: { title?: string; status?: string; body?: string; later?: string | null }) =>
  change(async () => {
    const story = await saveStory(ROOT, id, edit)
    if (!story) throw new Error(`No story ${id}`)
    return story
  })
export const fetchScreens = () => look(() => listScreens(ROOT))
export const fetchPersonas = () => look(() => listPersonas(ROOT))
export const createPersona = (input: { name: string; summary?: string }) => change(() => saveNewPersona(ROOT, input))
export type PersonaInput = Partial<Record<'name' | 'summary' | 'tier' | 'technical' | 'frequency' | 'learning_curve' | PersonaSection | 'body', string>> &
  Partial<Record<PersonaList, string[]>> & { segments?: Record<string, PersonaInSegment>; confirmed?: boolean }
export const updatePersona = (id: string, input: PersonaInput) =>
  change(async () => {
    const p = await savePersona(ROOT, id, input)
    if (!p) throw new Error(`No persona ${id}`)
    return p
  })
export const deletePersona = (id: string) =>
  change(async () => {
    if (!(await dropPersona(ROOT, id))) throw new Error(`No persona ${id}`)
  })
export const settleName = (name: string, to: string) =>
  change(async () => ({ persona: await settleAudienceName(ROOT, name.trim().slice(0, 200), to === 'new' || to === 'remove' ? to : { persona: to }) }))
export const fetchSegments = () => look(() => listSegments(ROOT))
export const createSegment = (name: string) => change(() => saveNewSegment(ROOT, { name }))
export type SegmentInput = { name?: string; type?: string; industry?: string; size_min?: number; size_max?: number; admins?: string[]; body?: string }
export const updateSegment = (id: string, input: SegmentInput) =>
  change(async () => {
    const s = await saveSegment(ROOT, id, input)
    if (!s) throw new Error(`No segment ${id}`)
    return s
  })
export const deleteSegment = (id: string) =>
  change(async () => {
    if (!(await dropSegment(ROOT, id))) throw new Error(`No segment ${id}`)
  })

export type ThreadOwner = { kind: 'node'; item: GNode } | { kind: 'screen'; item: Screen } | { kind: 'persona'; item: Persona } | { kind: 'segment'; item: Segment }
type ThreadKind = ThreadOwner['kind']

/** What a thread belongs to, when it exists, as the server's threadOwner. */
async function threadOwner(id: string): Promise<ThreadKind | null> {
  if (id.startsWith('n_')) return (await nodes.list()).some((n) => n.id === id) ? 'node' : null
  if (id.startsWith('pe_')) return (await listPersonas(ROOT)).some((p) => p.id === id) ? 'persona' : null
  if (id.startsWith('sg_')) return (await listSegments(ROOT)).some((s) => s.id === id) ? 'segment' : null
  return (await listScreens(ROOT)).some((s) => s.id === id) ? 'screen' : null
}
async function threadItem(kind: ThreadKind, id: string): Promise<ThreadOwner['item']> {
  if (kind === 'node') return (await listNodes()).find((n) => n.id === id)!
  const list = kind === 'persona' ? await listPersonas(ROOT) : kind === 'segment' ? await listSegments(ROOT) : await listScreens(ROOT)
  return (list as ThreadOwner['item'][]).find((x) => x.id === id)!
}
const OWNER = /^(?:n|p|pe|sg)_[A-Za-z0-9_-]{1,60}$/
export const undoEntry = (owner: string, run: string, text: string) =>
  change(async () => {
    const kind = OWNER.test(owner) ? await threadOwner(owner) : null
    if (!kind) throw new Error(`No ${owner}`)
    await removeOwnEntry(ROOT, owner, run, text)
    return { kind, run: null, item: await threadItem(kind, owner) } as ThreadOwner & { run: null }
  })
export const changeEntry = (owner: string, run: string, text: string, keep: boolean) =>
  change(async () => {
    const kind = OWNER.test(owner) ? await threadOwner(owner) : null
    if (!kind) throw new Error(`No ${owner}`)
    if (text.length > 20_000) throw new Error('That answer is too long')
    const now = await changeOwnEntry(ROOT, owner, run, text, keep)
    return { kind, run: now, item: await threadItem(kind, owner) } as ThreadOwner & { run: string }
  })
export const updateScreen = (id: string, input: { purpose?: string; audience?: string[]; tasks?: string[]; body?: string; hidden?: boolean; features?: string[]; part?: string }) =>
  change(async () => {
    // As the server's parseScreenEdit: only the words, the notes and these marks change from the map.
    const edit: ScreenEdit = {}
    const words = (v: string[]) => v.map((x) => x.trim()).filter(Boolean).slice(0, 50)
    if (input.purpose !== undefined) edit.purpose = input.purpose.trim().replace(/\s*\n\s*/g, ' ')
    if (input.audience !== undefined) edit.audience = words(input.audience)
    if (input.tasks !== undefined) edit.tasks = words(input.tasks)
    if (input.body !== undefined) edit.body = input.body
    if (input.features !== undefined) edit.features = [...new Set(words(input.features))]
    if (input.part !== undefined) edit.part = input.part.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (input.hidden !== undefined) edit.hidden = input.hidden ? today() : ''
    const s = await saveScreen(ROOT, id, edit)
    if (!s) throw new Error(`No screen ${id}`)
    return s
  })
export const fetchOutput = (name: 'brief.md' | 'CLAUDE.starter.md' | 'survey.md' | 'personas.md') => look(() => readOutput(ROOT, name))
export const fetchDraft = (name: string) => look(() => readDraft(ROOT, name))
export const fetchReadiness = () => look(() => readReadiness(ROOT))
export const markGapAnswered = (gapId: string, nodeId: string, enough = false) =>
  change(async () => {
    if (!(await nodes.list()).some((n) => n.id === nodeId)) throw new Error(`No node ${nodeId}`)
    if (!(await markAnswered(ROOT, gapId, nodeId, enough))) throw new Error(`No gap ${gapId}`)
    return readReadiness(ROOT)
  })
export const setFocusLater = (id: string, later: boolean) =>
  change(async () => {
    await saveFocusLater(ROOT, id, later)
    return readReadiness(ROOT)
  })
export const saveKickoff = (changes: Record<string, string | null>) =>
  change(async () => {
    for (const [step, date] of Object.entries(changes)) {
      if (!(KICKOFF_STEPS as readonly string[]).includes(step)) throw new Error(`Unknown kickoff step: ${step}`)
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A kickoff date must look like 2026-10-08')
    }
    await writeKickoff(ROOT, changes)
    return project()
  })
export const saveProjectFields = (fields: { start?: 'new' | 'existing'; purpose?: string; name?: string; initials?: string; color?: string }) =>
  change(async () => {
    // As the server's PATCH /api/project: plain words, up to three letters, a color like #3b82f6.
    const plain = (v: string, max: number) => v.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)
    const out: Record<string, string> = {}
    if (fields.name !== undefined) out.name = plain(fields.name, 80)
    if (fields.initials !== undefined) out.initials = [...plain(fields.initials, 12).replace(/\s/g, '')].slice(0, 3).join('')
    if (fields.color !== undefined) {
      const color = plain(fields.color, 7).toLowerCase()
      if (color && !/^#[0-9a-f]{6}$/.test(color)) throw new Error('A color looks like #3b82f6')
      out.color = color
    }
    if (fields.start !== undefined) out.start = fields.start === 'existing' ? 'existing' : 'new'
    if (fields.purpose !== undefined) out.purpose = fields.purpose.trim().replace(/\s*\n\s*/g, ' ').slice(0, 500)
    await writeFields(ROOT, out)
    return project()
  })
export const savePages = (pages: string[]) =>
  change(async () => {
    await writePages(ROOT, pages)
    return project()
  })
export const createNode = (input: NodeInput) =>
  change(async () => {
    const c = await nodes.create(input, session.name ? { by: session.name } : {})
    return (await listNodes()).find((n) => n.id === c.upserted[0].id)!
  })
export const updateNode = (id: string, input: NodeInput) =>
  change(async () => {
    await nodes.update(id, input)
    return (await listNodes()).find((n) => n.id === id)!
  })
/** A picture for a thought, a screen or a persona, into `files/<id>/` as grndwrk saves one. */
export async function uploadImage(id: string, file: Blob): Promise<{ markdown: string; url: string }> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') throw new Error('The store keeps PNG and JPEG pictures only')
  const bytes = new Uint8Array(await file.arrayBuffer())
  return change(async () => {
    const known = (await nodes.list()).some((n) => n.id === id) || (await listScreens(ROOT)).some((s) => s.id === id) || (await listPersonas(ROOT)).some((p) => p.id === id)
    if (!known) throw new Error(`No ${id}`)
    return saveImage(ROOT, id, file.type, bytes as never)
  })
}
export interface Shot {
  platform: 'web' | 'ios'
  key: string
  /** How a screen names it in shots: ios/App-2.jpg. */
  file: string
  url: string
  taken: string
  /** What the screen showed, from the app. */
  texts?: string[]
  /** A picture pasted into a reply or an answer, not one of a screen. */
  pasted?: boolean
}
// Pictures of screens stay on the Mac that took them (shots/ is never in a store).
export const fetchShots = async () => [] as Shot[]
export const placeShot = async (_file: string, _screen: string): Promise<Screen[]> => {
  throw new Error(ON_MAC)
}
export const fetchRuntime = async () => ({ app: null as string | null, proxied: false })
export const fetchPairRequests = async () => [] as PairRequest[]
export const answerPairRequest = async (_id: string, _allow: boolean): Promise<{ ok: true }> => {
  throw new Error(ON_MAC)
}
export interface AllowedSite { origin: string; kept: boolean }
export const fetchSites = async () => ({ asking: [] as string[], allowed: [] as AllowedSite[] })
export const answerSiteRequest = async (_origin: string, _allow: boolean): Promise<{ allowed: AllowedSite[] }> => {
  throw new Error(ON_MAC)
}
export const removeSite = answerSiteRequest
// Testing a fix is done where it was built: on the Mac, the phone or the staging site.
export const markTested = async (_id: string, _works: boolean, _note: string): Promise<{ state: 'fixed' | 'incoming'; node: GNode }> => {
  throw new Error('Test a fix on the Mac, or on the phone or site the comment came from.')
}
export interface RelayInfo {
  connected: boolean
  deployed?: boolean
  url?: string
  phones?: { id: string; name: string; joined: string }[]
  invites?: { id: string; name: string; expires: number }[]
  waiting?: { invite: string; name: string; digits: string }[]
  site?: string
  error?: string
}
export const fetchAuthors = async () => ({ me: session.name, first: {} as Record<string, string> })
export const fetchRelay = async () => ({ connected: false }) as RelayInfo
const macOnly = async (): Promise<never> => {
  throw new Error(ON_MAC)
}
export const inviteLinkAgain = (_id: string): Promise<{ id: string; name: string; link: string }> => macOnly()
export const inviteColleague = (_name: string): Promise<{ id: string; name: string; link: string }> => macOnly()
export const answerJoin = (_invite: string, _allow: boolean): Promise<RelayInfo> => macOnly()
export const removeFromRelay = (_kind: 'phones' | 'invites', _id: string): Promise<RelayInfo> => macOnly()
/** A comment through the relay opened here: `seen:` the first time anyone does, when this sign-in may write. */
export const markSeen = async (id: string) => {
  if (!session.writable) return { seen: false }
  const c = await change(() => nodes.markSeen(id))
  return { seen: c.upserted.length > 0 }
}
export const fetchViews = () => look(() => listViews(ROOT))
export const createView = (input: ViewSettings & { name: string }) => change(() => saveNewView(ROOT, input as unknown as Record<string, unknown>, session.name ? { by: session.name } : {}))
export const updateView = (id: string, input: { name?: string; settings?: ViewSettings }) =>
  change(async () => {
    const v = await saveView(ROOT, id, input)
    if (!v) throw new Error('That view is gone: someone deleted it.')
    return v
  })
export const deleteView = (id: string) =>
  change(async () => {
    if (!(await dropView(ROOT, id))) throw new Error('That view is gone: someone deleted it.')
  })
export const deleteNode = (id: string) =>
  change(async () => {
    await nodes.delete(id)
    await removeFiles(ROOT, id)
  })

// Questions waiting for someone's answer. Names the map may not hold stay in this tab only.
const LOCAL_NAMES = '/local/waiting.json'
export interface WaitingState { personal_info: 'yes' | 'no' | null; people: string[]; items: { key: string; on: string; question: string; since: string; for?: string }[] }
export const fetchWaiting = () => look(() => readWaiting(ROOT, LOCAL_NAMES)) as Promise<WaitingState>
export const saveWaiting = (input: { on: string; question: string; for?: string | null; clear?: boolean }) =>
  change(async () => {
    if (!/^(?:n|p|pe)_[A-Za-z0-9_]{1,60}$/.test(input.on)) throw new Error('A question waits on a thought, a screen or a persona')
    return (await setWaiting(ROOT, input, LOCAL_NAMES)) as WaitingState
  })
export const savePersonalInfo = (value: 'yes' | 'no') => change(async () => (await setPersonalInfo(ROOT, value, LOCAL_NAMES)) as WaitingState)

// Pictures in notes and threads

/**
 * A picture in the map (`../files/<id>/<name>`) is in the store, behind the
 * token, so an <img> cannot load it by its path. Its bytes are read with the
 * token and shown from a blob: URL; nothing else is ever loaded.
 */
const FILE_SRC = /^(?:\.\.\/)*\/?files\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:png|jpe?g))$/i
const pictures = new Map<string, { version: string; url: string }>()
function forgetPictures() {
  for (const p of pictures.values()) URL.revokeObjectURL(p.url)
  pictures.clear()
}
async function pictureUrl(path: string): Promise<string | null> {
  const had = pictures.get(path)
  if (had && had.version === vfs.storedVersion(path)) return had.url
  try {
    const bytes = (await vfs.readFile(`${ROOT}/${path}`)) as unknown as Uint8Array
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: typeOf(path) }))
    if (had) URL.revokeObjectURL(had.url)
    pictures.set(path, { version: vfs.storedVersion(path) ?? '', url })
    return url
  } catch {
    return null
  }
}

/** Show the map's pictures under `root` from the store, now and as the page changes. */
export function watchPictures(root: Element) {
  const swap = (img: HTMLImageElement) => {
    const src = img.getAttribute('src') ?? ''
    const m = FILE_SRC.exec(src)
    if (!m) return
    const path = `files/${m[1]}/${m[2]}`
    // Never ask the store's address for it without the token: nothing loads until the bytes are here.
    img.removeAttribute('src')
    img.dataset.storeSrc = path
    void pictureUrl(path).then((url) => {
      if (url && img.dataset.storeSrc === path && !img.getAttribute('src')) img.setAttribute('src', url)
    })
  }
  for (const img of root.querySelectorAll('img')) swap(img)
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.target instanceof HTMLImageElement) swap(m.target)
      for (const n of m.addedNodes) {
        if (n instanceof HTMLImageElement) swap(n)
        else if (n instanceof Element) for (const img of n.querySelectorAll('img')) swap(img)
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
}

// A team's other projects on the same store, for All projects

/** A project this person can reach on the store. */
export interface TeamProject {
  name: string
  url: string
  /** The project this page is. */
  current: boolean
  /** This tab has a token that reaches it. */
  signedIn: boolean
}

/** What All projects shows of one project, read from its own files with its own token. */
export interface TeamProjectRead {
  name: string
  overview: ProjectOverview
  thoughts: GNode[]
}

/** fetch called as itself: a browser refuses window.fetch called as another object's method. */
const browserFetch: typeof fetch = (input, init) => fetch(input, init)

/** Tokens the store said reach another project (`v1/projects`: the same token), by its address. */
const reaches = new Map<string, string>()
const keyFor = (url: string) => `grndwrk.token:${new URL(url).pathname}`
function tokenAt(url: string): string {
  if (url === base) return token
  try {
    return storage?.getItem(keyFor(url)) || reaches.get(url) || ''
  } catch {
    return reaches.get(url) ?? ''
  }
}

/** A project's address as the store gave it: on this store's own origin only, so a token never goes elsewhere. */
function projectUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) return ''
  try {
    const u = new URL(value, base)
    if (u.origin !== new URL(base).origin || u.username || u.password) return ''
    u.hash = ''
    u.search = ''
    return u.pathname.endsWith('/') ? u.toString() : ''
  } catch {
    return ''
  }
}

const plainName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 120) : '')
const nameOfUrl = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? url)

/**
 * The projects this person can reach: the store's list (`GET <store>/v1/projects`,
 * when it has one; 404 otherwise), every project this tab is signed in to
 * (tokens are kept per project), and this one.
 */
export async function teamProjects(): Promise<TeamProject[]> {
  const found = new Map<string, string>([[base, session.project]])
  try {
    const res = await fetch(new URL('../v1/projects', base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' })
    const body = res.ok ? ((await res.json().catch(() => null)) as { projects?: unknown } | null) : null
    for (const p of Array.isArray(body?.projects) ? body.projects.slice(0, 200) : []) {
      const url = projectUrl((p as { url?: unknown })?.url)
      if (!url) continue
      if (!found.get(url)) found.set(url, plainName((p as { name?: unknown }).name))
      if (url !== base) reaches.set(url, token)
    }
  } catch {
    // No list from the store: the projects this tab knows are enough.
  }
  try {
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i) ?? ''
      if (!key.startsWith('grndwrk.token:')) continue
      const url = projectUrl(key.slice('grndwrk.token:'.length))
      if (url && !found.has(url)) found.set(url, '')
    }
  } catch {
    // Blocked storage: only what the store listed.
  }
  return [...found].map(([url, name]) => ({ url, name: name || nameOfUrl(url), current: url === base, signedIn: !!tokenAt(url) }))
}

/** Every text file of a project's map, into memory under `root`, to read it with grndwrk's own store code. */
async function readMapInto(s: HttpStore, root: string) {
  let page = await s.changes({})
  const all = [...page.changes]
  while (page.more) {
    page = await s.changes({ since: page.cursor })
    all.push(...page.changes)
  }
  const wanted = all.filter((c) => !c.deleted && isMapPath(c.path) && !isPicture(typeOf(c.path)))
  for (let i = 0; i < wanted.length; i += 8) {
    await Promise.all(
      wanted.slice(i, i + 8).map(async ({ path }) => {
        const f = await s.read(path)
        if (f) vfs.putElsewhere(root, path, f.bytes)
      }),
    )
  }
}

async function filesAt(root: string): Promise<MapFiles> {
  const [nodes, screens, personas, stories, readiness] = await Promise.all([new NodeStore(root).list(), listScreens(root), listPersonas(root), listStories(root), readReadiness(root).catch(() => null)])
  return { nodes, screens, personas, stories, readiness }
}

/** Signing in at that project's address is needed: no token here, or the one there ran out. */
export class SignInThere extends Error {}

let peeks = 0
/** One project's card and its thoughts for the search, read with that project's own token. This project from what the page holds. */
export async function readTeamProject(url: string): Promise<TeamProjectRead> {
  if (url === base) {
    const files = await look(() => filesAt(ROOT))
    return { name: session.project, overview: overviewOf(files), thoughts: files.nodes }
  }
  const t = tokenAt(url)
  if (!t) throw new SignInThere('Sign in to see this project.')
  const s = new HttpStore(url, t, browserFetch)
  const root = `/peek/${++peeks}`
  try {
    const hello = await s.hello()
    if (hello.role === 'comment') throw new SignInThere('That sign-in may only leave comments there.')
    await readMapInto(s, root)
    const files = await filesAt(root)
    return { name: hello.project || nameOfUrl(url), overview: overviewOf(files), thoughts: files.nodes }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (/\(401\)/.test(why)) {
      reaches.delete(url)
      try {
        storage?.removeItem(keyFor(url))
      } catch {
        // Blocked storage: nothing kept to forget.
      }
      throw new SignInThere('Your sign-in there ran out. Sign in again.')
    }
    // fetch throws a TypeError only when nothing answered at all.
    if (err instanceof TypeError && /fetch|network/i.test(why)) throw new Error(OFFLINE_MESSAGE)
    throw err
  } finally {
    vfs.dropElsewhere(root)
  }
}

/** Sign in to another project, at its own address. Returns why not, or '' when signed in there. */
export async function signInToProject(url: string, t: string): Promise<string> {
  const there = projectUrl(url)
  const next = t.trim()
  if (!there) return 'That project is not on this store.'
  if (!next) return 'Paste the token your store gave you for that project.'
  try {
    const hello = await new HttpStore(there, next, browserFetch).hello()
    if (hello.role === 'comment') return 'That token may only leave comments. The page needs one that may read the map.'
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return /\(401\)|: 403/.test(why) ? 'The store did not take that token for this project.' : OFFLINE_MESSAGE
  }
  try {
    storage?.setItem(keyFor(there), next)
  } catch {
    // Blocked storage: signed in there for as long as this page is open.
  }
  reaches.set(there, next)
  return ''
}

/** Go to another project's page, signed in there when this tab can be, at a thought when one is named. */
export function openProjectPage(url: string, nodeId = '') {
  const there = projectUrl(url)
  if (!there) return
  const t = tokenAt(there)
  try {
    if (t && there !== base && !storage?.getItem(keyFor(there))) storage?.setItem(keyFor(there), t)
  } catch {
    // Blocked storage: the page there asks for a token.
  }
  location.assign(there + (/^n_[A-Za-z0-9_-]{1,60}$/.test(nodeId) ? `#open=${nodeId}` : ''))
}
