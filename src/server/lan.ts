import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { BadInput, type NodeStore } from '../store/nodes.js'
import type { NodeSync } from './events.js'
import { createFeedback, parseFeedback } from './feedback.js'

/**
 * What devices on the same network can reach, when `--lan` is on: they can
 * add a comment, and see that Groundwork is there. Nothing else. The map, the
 * API and the files stay on this machine only.
 */
export function createLanServer(ctx: { gwDir: string; store: NodeStore; nodes: NodeSync; project: string }): Server {
  const recent = new Map<string, number[]>()
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://lan').pathname
    try {
      if (path === '/api/hello' && req.method === 'GET') return json(res, 200, { groundwork: true, project: ctx.project })
      if (path !== '/api/feedback' || req.method !== 'POST') return json(res, 404, { error: 'Only comments can be sent here' })
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON' })
      // A phone sends a handful at a time. Anything more is not a person commenting.
      const ip = req.socket.remoteAddress ?? ''
      const now = Date.now()
      const times = (recent.get(ip) ?? []).filter((t) => now - t < 60_000)
      if (times.length >= 60) return json(res, 429, { error: 'Too many comments at once. Try again in a minute.' })
      recent.set(ip, [...times, now])
      const input = parseFeedback(JSON.parse((await readAll(req, 14_000_000)).toString('utf8')))
      const node = await createFeedback(ctx.gwDir, ctx.store, input)
      await ctx.nodes.sync()
      return json(res, 201, { id: node.id, title: node.title })
    } catch (err) {
      const bad = err instanceof BadInput || err instanceof SyntaxError
      if (!bad) console.error(err)
      return json(res, bad ? 400 : 500, { error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/**
 * Announce Groundwork on the network with Bonjour, so the iOS package finds
 * it without anyone typing an address. Uses macOS's own dns-sd. Returns a
 * function that stops the announcement, or null where dns-sd is missing.
 */
export function advertise(port: number, project: string): (() => void) | null {
  try {
    const child = spawn('dns-sd', ['-R', `Groundwork ${project}`.slice(0, 63), '_groundwork._tcp', 'local', String(port), `project=${project}`], { stdio: 'ignore' })
    child.on('error', () => {})
    const stop = () => child.kill()
    process.once('exit', stop)
    return stop
  } catch {
    return null
  }
}

/** This machine's addresses on the local network, for printing. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

async function readAll(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BadInput('Too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
