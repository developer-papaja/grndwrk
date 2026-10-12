import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { handleComments, type CommentsCtx } from './comments.js'

/**
 * What devices on the same network can reach, when `--lan` is on: they can
 * add a comment, see that Groundwork is there, and ask about or delete their
 * own comments by the key they made for each. Nothing else. The map, the API
 * and the files stay on this machine only.
 */
export function createLanServer(ctx: CommentsCtx): Server {
  const recent = new Map<string, number[]>()
  return createServer(async (req, res) => {
    // A phone sends a handful at a time. Anything more is not a person commenting.
    const ip = req.socket.remoteAddress ?? ''
    const now = Date.now()
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 60_000)
    if (times.length >= 120) return json(res, 429, { error: 'Too many requests at once. Try again in a minute.' })
    recent.set(ip, [...times, now])
    if (!(await handleComments(req, res, ctx))) json(res, 404, { error: 'Only comments can be sent here' })
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
