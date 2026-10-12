import type { IncomingMessage, ServerResponse } from 'node:http'
import { BadInput, type NodeStore } from '../store/nodes.js'
import { broadcast, clientCount, type NodeSync } from './events.js'
import { createFeedback, feedbackStatus, parseFeedback, removeFeedback } from './feedback.js'

export interface CommentsCtx {
  gwDir: string
  store: NodeStore
  nodes: NodeSync
  project: string
  /** The map in the browser, for opening a comment to write on the Mac. */
  uiUrl: string
}

/**
 * What the iOS package talks to, on localhost and with `--lan`:
 * - GET /api/hello: Groundwork is here, for which project, and whether a browser has the map open
 * - POST /api/feedback: a comment, or with on_mac, one to write in the browser
 * - POST /api/feedback/status: what became of comments the device sent, by id and key
 * - POST /api/feedback/remove: delete comments the device sent, by id and key
 * Returns false for anything else.
 */
export async function handleComments(req: IncomingMessage, res: ServerResponse, ctx: CommentsCtx): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const method = req.method ?? 'GET'
  if (path === '/api/hello' && method === 'GET') {
    return json(res, 200, { groundwork: true, project: ctx.project, browser: clientCount() > 0 })
  }
  if (!['/api/feedback', '/api/feedback/status', '/api/feedback/remove'].includes(path) || method !== 'POST') return false
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON' })
  try {
    const body = JSON.parse((await readAll(req, 14_000_000)).toString('utf8'))
    if (path === '/api/feedback/status') return json(res, 200, { comments: await feedbackStatus(ctx.store, body) })
    if (path === '/api/feedback/remove') {
      const removed = await removeFeedback(ctx.gwDir, ctx.store, body)
      await ctx.nodes.sync()
      return json(res, 200, { removed })
    }
    const input = parseFeedback(body)
    const node = await createFeedback(ctx.gwDir, ctx.store, input)
    await ctx.nodes.sync()
    let opened: 'browser' | 'new tab' | undefined
    if (input.onMac) opened = await openOnMac(node.id, ctx.uiUrl)
    return json(res, 201, { id: node.id, title: node.title, project: ctx.project, ...(opened ? { opened } : {}) })
  } catch (err) {
    const bad = err instanceof BadInput || err instanceof SyntaxError
    if (!bad) console.error(err)
    return json(res, bad ? 400 : 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

let lastTab = 0

/** Open a comment in the map with its title ready to type: in an open tab, or a new one. */
async function openOnMac(id: string, uiUrl: string): Promise<'browser' | 'new tab'> {
  if (clientCount() > 0) {
    broadcast({ type: 'node:open', id })
    return 'browser'
  }
  // Someone on the network could ask over and over. One new tab every few seconds at most.
  if (Date.now() - lastTab < 5000) return 'new tab'
  lastTab = Date.now()
  const { default: open } = await import('open')
  await open(`${uiUrl}/#write=${id}`).catch(() => {})
  return 'new tab'
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  return true
}

export async function readAll(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BadInput('Too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
