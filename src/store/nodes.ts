import { randomInt } from 'node:crypto'
import { LinkRefused, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from './fs.js'
import { join } from 'node:path'
import { NODE_TYPES, STATUSES, type GNode, type NodeInput } from '../shared/types.js'
import { DEFAULTS, isValidId, oneOf, parseNode, serializeNode, toAltitude, today } from './frontmatter.js'
import { readEntryFiles, removeEntries, saveBody, withEntries } from './threads.js'

export class NotFound extends Error {}
export class ReadOnly extends Error {}
export class BadInput extends Error {}

/** What a mutation changed, so the caller can broadcast it. */
export interface Change {
  upserted: GNode[]
  deleted: string[]
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export class NodeStore {
  readonly dir: string
  private readonly gwDir: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(groundworkDir: string) {
    this.gwDir = groundworkDir
    this.dir = join(groundworkDir, 'nodes')
  }

  pathFor(id: string): string {
    if (!isValidId(id)) throw new BadInput(`Invalid id: ${id}`)
    return join(this.dir, `${id}.md`)
  }

  /** All nodes, with links made symmetric in memory. Files are not touched. */
  async list(): Promise<GNode[]> {
    return (await this.read()).nodes
  }

  /**
   * All nodes, and the links each file holds itself. A link is written only
   * on the card that made it, so linking to a card everyone links to never
   * changes that card's file, and two people doing it never conflict in git.
   * In memory, links go both ways.
   */
  private async read(): Promise<{ nodes: GNode[]; own: Map<string, string[]>; bodies: Map<string, string> }> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return { nodes: [], own: new Map(), bodies: new Map() }
    }
    const nodes: GNode[] = []
    // The body each card's own file holds, without the entries kept in files of their own.
    const bodies = new Map<string, string>()
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -3)
      if (!isValidId(id)) continue
      try {
        const path = join(this.dir, file)
        const node = parseNode(id, await readFile(path, 'utf8'))
        node.modified = (await stat(path)).mtime.toISOString()
        if (!node.error) {
          bodies.set(id, node.body)
          node.body = withEntries(node.body, await readEntryFiles(this.gwDir, id))
        }
        nodes.push(node)
      } catch (err) {
        // A link (from a pull request) shows as unreadable, with why, never followed and never hidden.
        if (err instanceof LinkRefused) nodes.push({ ...parseNode(id, ''), error: err.message })
        // Otherwise deleted between readdir and readFile.
      }
    }
    const own = new Map(nodes.map((n) => [n.id, [...n.links]]))
    return { nodes: mergeLinks(nodes), own, bodies }
  }

  async get(id: string): Promise<GNode> {
    const node = (await this.list()).find((n) => n.id === id)
    if (!node) throw new NotFound(id)
    return node
  }

  /** Create a node. `extra` is for fields the server sets itself, never taken from a request. */
  create(input: NodeInput, extra: Record<string, unknown> = {}): Promise<Change> {
    return this.serial(async () => {
      const title = input.title?.trim()
      if (!title) throw new BadInput('A title is required')
      const { nodes: all, own } = await this.read()
      const byId = new Map(all.map((n) => [n.id, n]))
      let id: string
      do id = newId('n_')
      while (byId.has(id))

      const node: GNode = {
        id,
        type: DEFAULTS.type,
        title,
        topic: '',
        page: '',
        altitude: DEFAULTS.altitude,
        links: [],
        status: DEFAULTS.status,
        created: today(),
        body: '',
        extra: {},
      }
      Object.assign(node, clean(input))
      // A thought written as the answer to a gap remembers which gap, even after the gap closes.
      if (typeof input.answers === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.answers)) node.extra = { answers: input.answers }
      if (typeof input.screen === 'string' && SCREEN_ID.test(input.screen)) node.extra = { ...node.extra, screen: input.screen }
      // A comment on a document in the product: a Markdown path inside the project, and the heading.
      if (typeof input.doc === 'string' && /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./ -]{1,160}\.(md|markdown)$/i.test(input.doc)) {
        node.extra = { ...node.extra, doc: input.doc }
        if (typeof input.doc_section === 'string' && input.doc_section.trim()) node.extra = { ...node.extra, doc_section: input.doc_section.replace(/\s+/g, ' ').trim().slice(0, 120) }
      }
      node.extra = { ...node.extra, ...extra }
      node.links = [...new Set(input.links ?? [])].filter((l) => byId.has(l))
      own.set(id, node.links)
      await this.write(node, own, node.body)
      return this.changed([id, ...node.links])
    })
  }

  update(id: string, input: NodeInput): Promise<Change> {
    return this.serial(async () => {
      const { nodes: all, own, bodies } = await this.read()
      const byId = new Map(all.map((n) => [n.id, n]))
      const current = byId.get(id)
      if (!current) throw new NotFound(id)
      if (current.error) throw new ReadOnly(`${id}.md could not be parsed: ${current.error}`)
      if (input.title !== undefined && !input.title.trim()) throw new BadInput('A title is required')

      const next: GNode = { ...current, ...clean(input), links: [...current.links] }
      // A topic set here is the person's own. Claude may only revise topics it set itself.
      if (input.topic !== undefined) {
        const { topic_by: _, ...rest } = current.extra
        next.extra = rest
      }
      if (input.screen !== undefined) {
        const { screen: _, ...rest } = next.extra
        next.extra = typeof input.screen === 'string' && SCREEN_ID.test(input.screen) ? { ...rest, screen: input.screen } : rest
      }
      // Only the person marks a comment fixed, from the panel. A date sets it, empty takes it back.
      if (input.fixed !== undefined) {
        const { fixed: _, ...rest } = next.extra
        next.extra = typeof input.fixed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.fixed) ? { ...rest, fixed: input.fixed } : rest
      }
      if (input.built !== undefined) {
        const { built: _, ...rest } = next.extra
        next.extra = typeof input.built === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.built) ? { ...rest, built: input.built } : rest
      }
      if (input.proposed !== undefined) {
        const { proposed: _, ...rest } = next.extra
        next.extra = typeof input.proposed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.proposed) ? { ...rest, proposed: input.proposed } : rest
      }
      const touched = [id]
      if (input.links) {
        const wanted = [...new Set(input.links)].filter((l) => l !== id && byId.has(l))
        const added = wanted.filter((l) => !current.links.includes(l))
        const removed = current.links.filter((l) => !wanted.includes(l))
        // A new link is written on this card only. A link taken away is taken
        // off whichever card holds it, which may be the other one.
        own.set(id, [...(own.get(id) ?? []).filter((l) => !removed.includes(l)), ...added])
        for (const other of removed) {
          const theirs = own.get(other) ?? []
          if (!theirs.includes(id)) continue
          own.set(other, theirs.filter((l) => l !== id))
          const node = byId.get(other)
          if (node && !node.error) await this.write(node, own, bodies.get(other) ?? '')
        }
        touched.push(...added, ...removed)
      }
      // New thread entries go to files of their own; the card's file keeps its own body.
      const body = input.body !== undefined ? await saveBody(this.gwDir, id, bodies.get(id) ?? '', String(input.body)) : (bodies.get(id) ?? '')
      // Only a thread entry added: the card's own file stays exactly as it is, so
      // nothing in it can clash with someone else's change in git.
      const onlyBody = Object.entries(input).every(([k, v]) => k === 'body' || v === undefined)
      if (!(onlyBody && body === bodies.get(id))) await this.write(next, own, body)
      return this.changed(touched)
    })
  }

  delete(id: string): Promise<Change> {
    return this.serial(async () => {
      const { nodes: all, own, bodies } = await this.read()
      const current = all.find((n) => n.id === id)
      if (!current) throw new NotFound(id)
      await unlink(this.pathFor(id))
      await removeEntries(this.gwDir, id)
      // Cards that held a link to it no longer do.
      for (const other of all) {
        const theirs = own.get(other.id) ?? []
        if (other.id === id || other.error || !theirs.includes(id)) continue
        own.set(other.id, theirs.filter((l) => l !== id))
        await this.write(other, own, bodies.get(other.id) ?? '')
      }
      const change = await this.changed(current.links)
      return { upserted: change.upserted, deleted: [id] }
    })
  }

  /**
   * The nodes a change touched, as they read now, with links both ways, in
   * the order given: the node created or changed comes first, since callers
   * take `upserted[0]` as that one.
   */
  private async changed(ids: string[]): Promise<Change> {
    const byId = new Map((await this.list()).map((n) => [n.id, n]))
    const upserted = [...new Set(ids)].map((id) => byId.get(id)).filter((n): n is GNode => !!n)
    return { upserted, deleted: [] }
  }

  /** Write a node with the links its own file holds, not the ones other cards point back with. */
  private async write(node: GNode, own: Map<string, string[]>, body: string): Promise<void> {
    const path = this.pathFor(node.id)
    const content = serializeNode({ ...node, links: own.get(node.id) ?? [], body })
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${node.id}.md.tmp`)
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  }

  /** Run mutations one at a time so read, modify, write never interleaves. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }
}

/** Normalize client input the same way a file is normalized. Bad values fall back to defaults. */
/** A screen id from screens/, like p_k2m4. */
const SCREEN_ID = /^p_[A-Za-z0-9_-]{1,60}$/

function clean(input: NodeInput): Partial<GNode> {
  const out: Partial<GNode> = {}
  if (input.title !== undefined) out.title = String(input.title).trim()
  if (input.topic !== undefined) out.topic = String(input.topic ?? '').trim()
  if (input.page !== undefined) out.page = String(input.page ?? '').trim()
  if (input.type !== undefined) out.type = oneOf(input.type, NODE_TYPES, DEFAULTS.type)
  if (input.altitude !== undefined) out.altitude = toAltitude(input.altitude)
  if (input.status !== undefined) out.status = oneOf(input.status, STATUSES, DEFAULTS.status)
  if (input.body !== undefined) out.body = String(input.body)
  return out
}

/** If A lists B, B lists A too. Links to nodes that do not exist are kept as is. */
export function mergeLinks(nodes: GNode[]): GNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    for (const l of n.links) {
      const other = byId.get(l)
      if (other && !other.links.includes(n.id)) other.links.push(n.id)
    }
  }
  return nodes
}

export function newId(prefix: string): string {
  let s = prefix
  // Six characters: two people adding a hundred cards each on their own
  // branches pick the same id about once in 460,000 merges.
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}
