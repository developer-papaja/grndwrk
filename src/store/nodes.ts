import { randomInt } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NODE_TYPES, STATUSES, type GNode, type NodeInput } from '../shared/types.js'
import { DEFAULTS, isValidId, oneOf, parseNode, serializeNode, toAltitude, today } from './frontmatter.js'

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
  private queue: Promise<unknown> = Promise.resolve()

  constructor(groundworkDir: string) {
    this.dir = join(groundworkDir, 'nodes')
  }

  pathFor(id: string): string {
    if (!isValidId(id)) throw new BadInput(`Invalid id: ${id}`)
    return join(this.dir, `${id}.md`)
  }

  /** All nodes, with links made symmetric in memory. Files are not touched. */
  async list(): Promise<GNode[]> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return []
    }
    const nodes: GNode[] = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -3)
      if (!isValidId(id)) continue
      try {
        const path = join(this.dir, file)
        const node = parseNode(id, await readFile(path, 'utf8'))
        node.modified = (await stat(path)).mtime.toISOString()
        nodes.push(node)
      } catch {
        // Deleted between readdir and readFile.
      }
    }
    return mergeLinks(nodes)
  }

  async get(id: string): Promise<GNode> {
    const node = (await this.list()).find((n) => n.id === id)
    if (!node) throw new NotFound(id)
    return node
  }

  create(input: NodeInput): Promise<Change> {
    return this.serial(async () => {
      const title = input.title?.trim()
      if (!title) throw new BadInput('A title is required')
      const all = await this.list()
      const byId = new Map(all.map((n) => [n.id, n]))
      let id: string
      do id = newId('n_')
      while (byId.has(id))

      const node: GNode = {
        id,
        type: DEFAULTS.type,
        title,
        topic: '',
        altitude: DEFAULTS.altitude,
        links: [],
        status: DEFAULTS.status,
        created: today(),
        body: '',
        extra: {},
      }
      Object.assign(node, clean(input))
      node.links = [...new Set(input.links ?? [])].filter((l) => byId.has(l))
      byId.set(id, node)
      return this.writeWithLinks(byId, node, [])
    })
  }

  update(id: string, input: NodeInput): Promise<Change> {
    return this.serial(async () => {
      const all = await this.list()
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
      if (input.links) next.links = [...new Set(input.links)].filter((l) => l !== id && byId.has(l))
      byId.set(id, next)
      return this.writeWithLinks(byId, next, current.links)
    })
  }

  delete(id: string): Promise<Change> {
    return this.serial(async () => {
      const all = await this.list()
      const current = all.find((n) => n.id === id)
      if (!current) throw new NotFound(id)
      await unlink(this.pathFor(id))
      const upserted: GNode[] = []
      for (const other of all) {
        if (other.id === id || other.error || !other.links.includes(id)) continue
        other.links = other.links.filter((l) => l !== id)
        await this.write(other)
        upserted.push(other)
      }
      return { upserted, deleted: [id] }
    })
  }

  /**
   * Write `node` and bring every node it links to, or used to link to, in line.
   * Writing the full merged link list also repairs one sided links left by hand edits.
   */
  private async writeWithLinks(byId: Map<string, GNode>, node: GNode, before: string[]): Promise<Change> {
    await this.write(node)
    const upserted = [node]
    const added = node.links.filter((l) => !before.includes(l))
    const removed = before.filter((l) => !node.links.includes(l))
    for (const otherId of [...added, ...removed]) {
      const other = byId.get(otherId)
      if (!other || other.error) continue
      const has = other.links.includes(node.id)
      if (added.includes(otherId) && !has) other.links = [...other.links, node.id]
      else if (removed.includes(otherId) && has) other.links = other.links.filter((l) => l !== node.id)
      else continue
      await this.write(other)
      upserted.push(other)
    }
    return { upserted, deleted: [] }
  }

  private async write(node: GNode): Promise<void> {
    const path = this.pathFor(node.id)
    const content = serializeNode(node)
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
function clean(input: NodeInput): Partial<GNode> {
  const out: Partial<GNode> = {}
  if (input.title !== undefined) out.title = String(input.title).trim()
  if (input.topic !== undefined) out.topic = String(input.topic ?? '').trim()
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
  for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}
