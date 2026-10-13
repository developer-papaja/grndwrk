import { spawn } from 'node:child_process'
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { clientCount } from './events.js'
import { handleComments, readAll, type CommentsCtx } from './comments.js'
import type { Pairings } from './pairing.js'
import { keepOutOfGit } from '../store/gitignore.js'

/** A comment with its picture is well under this. */
export const LAN_LIMIT = 4_000_000
/** What the whole network may send in an hour, so nobody can fill the disk. */
const HOUR_BUDGET = 200_000_000
/** Wrong codes one device may try in ten minutes. */
const WRONG_TRIES = 10

/**
 * What devices on the same network can reach, when `--lan` is on: they can
 * see that Groundwork is there, and with the pairing code add a comment, and
 * ask about or delete their own comments by the key they made for each.
 * Nothing else. The map, the API and the files stay on this machine only.
 */
export function createLanServer(ctx: CommentsCtx, code: string, pairings?: Pairings): Server {
  const lan: CommentsCtx = { ...ctx, via: 'lan', limit: LAN_LIMIT }
  const recent = new Map<string, number[]>()
  const wrong = new Map<string, number[]>()
  let spent: { at: number; bytes: number }[] = []
  return createServer(async (req, res) => {
    // Phones reach this by an address or a .local name. A web page that points
    // its own domain at this machine (DNS rebinding) sends its domain: refused.
    if (!isLanHost(req.headers.host)) return json(res, 403, { error: 'Forbidden' })
    // A phone sends a handful at a time. Anything more is not a person commenting.
    const ip = req.socket.remoteAddress ?? ''
    const now = Date.now()
    if (recent.size > 512) prune(recent, now - 60_000)
    if (wrong.size > 512) prune(wrong, now - 600_000)
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 60_000)
    if (times.length >= 120) return json(res, 429, { error: 'Too many requests at once. Try again in a minute.' })
    recent.set(ip, [...times, now])

    // A device that keeps guessing the code gets no more answers to its guesses
    // for a while. The right code still works, so nobody is shut out by a neighbour.
    const sent = req.headers['x-groundwork-code']
    const paired = typeof sent === 'string' && sameCode(sent, code)
    if (typeof sent === 'string' && sent && !paired) {
      const misses = (wrong.get(ip) ?? []).filter((t) => now - t < 600_000)
      if (misses.length >= WRONG_TRIES) return json(res, 429, { error: 'Too many wrong codes. Try again in ten minutes.' })
      wrong.set(ip, [...misses, now])
    }

    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (path === '/api/hello' && req.method === 'GET') {
      // Answers without the code, so the phone can tell Groundwork is there and ask for it.
      // With ?challenge=, it also proves it knows the code without sending it: a
      // phone sends its code and comments only to a Groundwork that can.
      const challenge = url.searchParams.get('challenge') ?? ''
      const proof = /^[A-Za-z0-9-]{16,64}$/.test(challenge) ? helloProof(code, challenge) : undefined
      return json(res, 200, { groundwork: true, project: ctx.project, paired, ...(proof ? { proof } : {}) })
    }
    // Asking the person at the Mac to allow this phone, which then gets the code. Needs no code.
    if (pairings && req.method === 'POST' && (path === '/api/pair' || path === '/api/pair/status')) {
      try {
        const body = JSON.parse((await readAll(req, 10_000)).toString('utf8'))
        if (path === '/api/pair/status') return json(res, 200, pairings.status(body))
        const asked = pairings.ask(body, ip)
        if (!asked) return json(res, 429, { error: 'Groundwork is not taking this request. Try again in a few minutes.' })
        return json(res, 202, { waiting: true, browser: clientCount() > 0 })
      } catch {
        return json(res, 400, { error: 'Send { request, device, app }' })
      }
    }
    if (!paired) return json(res, 401, { error: 'Allow this phone in Groundwork on the Mac, or enter the code it shows in the terminal', code_needed: true })

    if (req.method === 'POST') {
      const length = Number(req.headers['content-length'])
      if (!Number.isFinite(length)) return json(res, 411, { error: 'Send a Content-Length' })
      if (length > LAN_LIMIT) return json(res, 413, { error: 'Too large' })
      spent = spent.filter((s) => now - s.at < 3_600_000)
      if (spent.reduce((sum, s) => sum + s.bytes, 0) + length > HOUR_BUDGET) return json(res, 429, { error: 'Enough comments for this hour. Try again later.' })
      spent.push({ at: now, bytes: length })
    }
    if (!(await handleComments(req, res, lan))) json(res, 404, { error: 'Only comments can be sent here' })
  })
}

/** HMAC-SHA256 of the challenge, keyed by the code, as hex. The phone works out the same with the code it keeps. */
export function helloProof(code: string, challenge: string): string {
  return createHmac('sha256', code).update(`groundwork-hello:${challenge}`).digest('hex')
}

/** An address, or a .local name: what a phone on the network uses. Never a domain a web page could own. */
export function isLanHost(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase()
  if (!name) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true
  if (/^\[[0-9a-f:.%a-z0-9]+\]$/.test(name)) return true
  return name === 'localhost' || name.endsWith('.local')
}

function prune(map: Map<string, number[]>, before: number) {
  for (const [k, times] of map) if (!times.some((t) => t >= before)) map.delete(k)
}

/** Easy to read out and type on a phone: no 0, O, 1, I or L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
}

/** Codes are typed by people: case and spaces do not matter. */
function sameCode(sent: string, code: string): boolean {
  const a = Buffer.from(sent.replace(/[\s-]/g, '').toUpperCase())
  const b = Buffer.from(code)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The project's pairing code, kept in `.groundwork/lan-code` so a phone
 * paired once stays paired. The file stays out of git. Delete it for a new code.
 */
export async function pairingCode(gwDir: string): Promise<string> {
  const file = join(gwDir, 'lan-code')
  const kept = (await readFile(file, 'utf8').catch(() => '')).trim().toUpperCase()
  if (/^[A-Z0-9]{6}$/.test(kept)) return kept
  const code = newCode()
  await writeFile(file, code + '\n', { mode: 0o600 })
  await keepOutOfGit(gwDir, 'lan-code')
  return code
}

/**
 * dns-sd runs under a small shell that waits on a pipe from this process.
 * However Groundwork ends (Ctrl+C, kill, kill -9, a crash, the terminal
 * closing), the pipe closes and the shell stops dns-sd, so no advert is left
 * pointing phones at a port where nothing listens.
 */
const ADVERT = 'dns-sd -R "$@" >/dev/null 2>&1 & pid=$!; trap \'kill $pid 2>/dev/null\' EXIT HUP INT TERM; read _ignored'

/**
 * Announce Groundwork on the network with Bonjour, so the iOS package finds
 * it without anyone typing an address. Uses macOS's own dns-sd. Returns a
 * function that stops the announcement, or null where dns-sd is missing.
 */
export function advertise(port: number, project: string): (() => void) | null {
  try {
    const name = `Groundwork ${project}`.slice(0, 63)
    const child = spawn('/bin/sh', ['-c', ADVERT, 'groundwork-advert', name, '_groundwork._tcp', 'local', String(port), `project=${project}`], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', () => {})
    child.stdin?.on('error', () => {})
    // Closing the pipe is what stops it; the shell then stops dns-sd.
    const stop = () => child.stdin?.destroy()
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
