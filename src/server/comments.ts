import type { IncomingMessage, ServerResponse } from 'node:http'
import { BadInput, type NodeStore } from '../store/nodes.js'
import { broadcast, clientCount, type NodeSync } from './events.js'
import { createFeedback, feedbackStatus, ownComments, parseFeedback, removeFeedback, testedOnDevice } from './feedback.js'
import { saveIosShot, type ShotAbout } from '../store/shots.js'
import { openTarget } from '../opener.js'

export interface CommentsCtx {
  gwDir: string
  store: NodeStore
  nodes: NodeSync
  project: string
  /** The map in the browser, for opening a comment to write on the Mac. */
  uiUrl: string
  /** Set for the LAN listener: comments are marked `via: lan`, and bodies are smaller. */
  via?: 'lan'
  /** The largest body accepted, in bytes. */
  limit?: number
}

/**
 * What the iOS package talks to, on localhost and with `--lan`:
 * - GET /api/hello: grndwrk is here, for which project, and whether a browser has the map open
 * - POST /api/feedback: a comment, or with on_mac, one to write in the browser
 * - POST /api/feedback/status: what became of comments the device sent, by id and key
 * - POST /api/feedback/remove: delete comments the device sent, by id and key
 * - POST /api/feedback/show: open a comment the device sent in the map on the Mac
 * - POST /api/feedback/tested: the person tested a proposed fix on the device: fixed, or back to incoming with a note
 * - POST /api/screenshot: a picture of the screen the app shows, for the sitemap
 * Returns false for anything else.
 */
export async function handleComments(req: IncomingMessage, res: ServerResponse, ctx: CommentsCtx, read?: Buffer): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const method = req.method ?? 'GET'
  if (path === '/api/hello' && method === 'GET') {
    return json(res, 200, { grndwrk: true, project: ctx.project, browser: clientCount() > 0 })
  }
  if (!['/api/feedback', '/api/feedback/status', '/api/feedback/remove', '/api/feedback/tested', '/api/feedback/show', '/api/screenshot'].includes(path) || method !== 'POST') return false
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON' })
  try {
    // The LAN listener has read the body already, to check its signature.
    const body = JSON.parse((read ?? (await readAll(req, ctx.limit ?? 14_000_000))).toString('utf8'))
    if (path === '/api/feedback/status') return json(res, 200, { comments: await feedbackStatus(ctx.store, body) })
    if (path === '/api/screenshot') {
      const { about, data } = parseScreenshot(body)
      const key = await saveIosShot(ctx.gwDir, about, data)
      return json(res, 201, { saved: key })
    }
    if (path === '/api/feedback/show') {
      // Open a comment the device sent in the map on the Mac, to see what changed. Only by its key.
      const own = await ownComments(ctx.store, body)
      if (!own.length) return json(res, 404, { error: 'No comment of yours by that id' })
      return json(res, 200, { opened: await openOnMac(own[0], ctx.uiUrl) })
    }
    if (path === '/api/feedback/tested') {
      const tested = await testedOnDevice(ctx.store, body)
      await ctx.nodes.sync()
      return json(res, 200, { tested })
    }
    if (path === '/api/feedback/remove') {
      const removed = await removeFeedback(ctx.gwDir, ctx.store, body)
      await ctx.nodes.sync()
      return json(res, 200, { removed })
    }
    const input = parseFeedback(body)
    const node = await createFeedback(ctx.gwDir, ctx.store, input, ctx.via)
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

/**
 * { screen, component?, named?, texts?, ids?, image }: kept under the view's
 * type when known, else its title, with what the screen showed next to it.
 * The texts come from the app, so they are data: short strings, a few dozen.
 */
export function parseScreenshot(body: unknown): { about: ShotAbout; data: Buffer } {
  const b = (body ?? {}) as Record<string, unknown>
  const name = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 120) : '')
  const key = name(b.component) || name(b.screen)
  if (!key) throw new BadInput('Say which screen it is')
  const strings = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map((x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, 80) : '')).filter(Boolean))].slice(0, 60) : []
  const m = typeof b.image === 'string' ? /^data:image\/jpeg;base64,(.+)$/s.exec(b.image) : null
  if (!m) throw new BadInput('Send the picture as a JPEG data URL')
  const data = Buffer.from(m[1], 'base64')
  // A JPEG starts with FF D8 FF.
  if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new BadInput('That is not a JPEG')
  return { about: { screen: key, named: b.named === true, texts: strings(b.texts), ids: strings(b.ids) }, data }
}

let lastTab = 0

/** Open a comment in the map with its title ready to type: in an open tab, or a new one. */
export async function openOnMac(id: string, uiUrl: string): Promise<'browser' | 'new tab'> {
  if (clientCount() > 0) {
    broadcast({ type: 'node:open', id })
    return 'browser'
  }
  // Someone on the network could ask over and over. One new tab every few seconds at most.
  if (Date.now() - lastTab < 5000) return 'new tab'
  lastTab = Date.now()
  await openTarget(`${uiUrl}/#write=${id}`).catch(() => {})
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
