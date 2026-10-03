import type { IncomingMessage, ServerResponse } from 'node:http'
import { BadInput, NotFound, ReadOnly, type NodeStore } from '../store/nodes.js'
import { readProject, writePages } from '../store/project.js'
import { MAX_IMAGE_BYTES, readImage, removeFiles, saveImage } from '../store/files.js'
import type { NodeInput } from '../shared/types.js'
import { subscribe, type NodeSync } from './events.js'

interface Ctx {
  gwDir: string
  store: NodeStore
  nodes: NodeSync
}

/** Handles /api/*. Returns false when the request is not an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false
  const method = req.method ?? 'GET'
  const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/)
  const filesMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/files$/)

  try {
    // Images come as their own bytes, not JSON. A cross site page cannot send
    // an image content type without asking first, which we never allow.
    if (filesMatch && method === 'POST') {
      const id = decodeURIComponent(filesMatch[1])
      await ctx.store.get(id)
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
      const data = await readRaw(req, MAX_IMAGE_BYTES)
      try {
        return send(res, 201, await saveImage(ctx.gwDir, id, type, data))
      } catch (err) {
        throw new BadInput(err instanceof Error ? err.message : String(err))
      }
    }

    if ((method === 'POST' || method === 'PATCH') && !isJson(req)) return send(res, 415, { error: 'Send JSON' })

    if (url.pathname === '/api/events' && method === 'GET') {
      subscribe(res)
      return true
    }
    if (url.pathname === '/api/project' && method === 'GET') {
      const { data, body, pages } = await readProject(ctx.gwDir)
      return send(res, 200, { ...data, body, pages })
    }
    if (url.pathname === '/api/project' && method === 'PATCH') {
      const input = (await readBody(req)) as { pages?: unknown }
      if (!Array.isArray(input.pages) || !input.pages.every((p) => typeof p === 'string')) {
        throw new BadInput('pages must be a list of names')
      }
      await writePages(ctx.gwDir, input.pages)
      const { data, body, pages } = await readProject(ctx.gwDir)
      return send(res, 200, { ...data, body, pages })
    }
    if (url.pathname === '/api/nodes' && method === 'GET') {
      return send(res, 200, await ctx.store.list())
    }
    if (url.pathname === '/api/nodes' && method === 'POST') {
      const change = await ctx.store.create(await readBody(req))
      await ctx.nodes.sync()
      return send(res, 201, change.upserted[0])
    }
    if (nodeMatch && method === 'PATCH') {
      const change = await ctx.store.update(decodeURIComponent(nodeMatch[1]), await readBody(req))
      await ctx.nodes.sync()
      return send(res, 200, change.upserted[0])
    }
    if (nodeMatch && method === 'DELETE') {
      const id = decodeURIComponent(nodeMatch[1])
      await ctx.store.delete(id)
      await removeFiles(ctx.gwDir, id)
      await ctx.nodes.sync()
      res.writeHead(204).end()
      return true
    }
    return send(res, 404, { error: 'Not found' })
  } catch (err) {
    if (err instanceof BadInput) return send(res, 400, { error: err.message })
    if (err instanceof NotFound) return send(res, 404, { error: `No node ${err.message}` })
    if (err instanceof ReadOnly) return send(res, 409, { error: err.message })
    console.error(err)
    return send(res, 500, { error: 'Something went wrong' })
  }
}

/**
 * Requiring a JSON content type means a page on another site cannot write
 * here with a plain form post; the browser would have to ask first, and we never answer yes.
 */
function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').startsWith('application/json')
}

async function readBody(req: IncomingMessage): Promise<NodeInput> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new BadInput('Body too large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error()
    if (body.links !== undefined && !Array.isArray(body.links)) throw new BadInput('links must be a list')
    return body
  } catch (err) {
    if (err instanceof BadInput) throw err
    throw new BadInput('Invalid JSON')
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BadInput('Images can be at most 10 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Serve /files/<node id>/<name>, and nothing else from disk. */
export async function handleFiles(req: IncomingMessage, res: ServerResponse, gwDir: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = url.pathname.match(/^\/files\/([^/]+)\/([^/]+)$/)
  if (!m || req.method !== 'GET') return false
  const image = await readImage(gwDir, decodeURIComponent(m[1]), decodeURIComponent(m[2]))
  if (!image) {
    res.writeHead(404).end()
    return true
  }
  res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=31536000, immutable' }).end(image.data)
  return true
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  return true
}
