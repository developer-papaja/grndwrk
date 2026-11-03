import { spawn } from 'node:child_process'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from '../store/fs.js'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { clientCount } from './events.js'
import { handleComments, readAll, type CommentsCtx } from './comments.js'
import type { Pairings } from './pairing.js'
import type { Devices } from './devices.js'
import { keepOutOfGit } from '../store/gitignore.js'
import { cleanText } from '../shared/text.js'

/** A comment with its picture is well under this. */
export const LAN_LIMIT = 4_000_000
/** What the whole network may send in an hour, so nobody can fill the disk. */
const HOUR_BUDGET = 200_000_000
/** Wrong codes one device may try in ten minutes. */
const WRONG_TRIES = 10
/** Wrong codes the whole network may try in an hour, however many addresses it uses. Asking in the map still works after. */
const WRONG_PER_HOUR = 30

/**
 * What devices on the same network can reach, when `--lan` is on: they can
 * see that grndwrk is there, and once paired add a comment, and ask about
 * or delete their own comments by the key they made for each. Pairing gives
 * a phone its own key (devices.ts), by the person allowing it in the map or
 * by typing the code once; every later request is signed with it.
 * Nothing else. The map, the API and the files stay on this machine only.
 */
export function createLanServer(ctx: CommentsCtx, code: string, devices: Devices, pairings?: Pairings): Server {
  const lan: CommentsCtx = { ...ctx, via: 'lan', limit: LAN_LIMIT }
  const recent = new Map<string, number[]>()
  const wrong = new Map<string, number[]>()
  let wrongAll: number[] = []
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

    // A device that keeps guessing gets no more answers to its guesses for a
    // while, and so does the whole network after enough wrong ones in an hour.
    const missed = () => {
      wrong.set(ip, [...(wrong.get(ip) ?? []).filter((t) => now - t < 600_000), now])
      wrongAll = [...wrongAll.filter((t) => now - t < 3_600_000), now]
    }
    const guessedTooOften = () =>
      (wrong.get(ip) ?? []).filter((t) => now - t < 600_000).length >= WRONG_TRIES || wrongAll.filter((t) => now - t < 3_600_000).length >= WRONG_PER_HOUR

    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if (path === '/api/hello' && req.method === 'GET') {
      // Answers without a key, so the phone can tell grndwrk is there and ask to pair.
      // With ?device= and ?challenge=, it also proves it holds that phone's key without
      // sending it: a phone sends comments only to a grndwrk that can. The key is long
      // and random, so a recorded proof lets nobody work it out.
      const device = url.searchParams.get('device')
      const proof = devices.proof(device, url.searchParams.get('challenge') ?? '')
      return json(res, 200, { grndwrk: true, project: ctx.project, paired: !!devices.byId(device), ...(proof ? { proof } : {}) })
    }
    // Pairing: asking the person at the Mac to allow this phone, or typing the code once.
    // Either gives the phone its own key. Needs no key.
    if (req.method === 'POST' && (path === '/api/pair' || path === '/api/pair/status' || path === '/api/pair/code')) {
      try {
        const body = JSON.parse((await readAll(req, 10_000)).toString('utf8'))
        if (path === '/api/pair/code') {
          if (guessedTooOften()) return json(res, 429, { error: 'Too many wrong codes. Try again later, or allow this phone in grndwrk on the Mac.' })
          if (typeof body?.code !== 'string' || !sameCode(body.code, code)) {
            missed()
            return json(res, 401, { error: 'That is not the code grndwrk shows', code_needed: true })
          }
          const name = typeof body.device === 'string' ? cleanText(body.device).trim().slice(0, 60) : ''
          return json(res, 200, { key: await devices.add(name || 'A phone') })
        }
        if (!pairings) return json(res, 404, { error: 'Pair by typing the code grndwrk shows' })
        if (path === '/api/pair/status') return json(res, 200, pairings.status(body))
        const asked = pairings.ask(body, ip)
        if (!asked) return json(res, 429, { error: 'grndwrk is not taking this request. Try again in a few minutes.' })
        return json(res, 202, { waiting: true, browser: clientCount() > 0 })
      } catch {
        return json(res, 400, { error: 'Send { request, device, app }' })
      }
    }
    // Everything else is signed by a paired phone. A phone from before keys sends its code instead: it must pair again.
    const unpaired = { error: 'Allow this phone in grndwrk on the Mac, or enter the code it shows in the terminal', code_needed: true }
    if (req.method !== 'POST') return json(res, req.headers['x-grndwrk-device'] ? 404 : 401, req.headers['x-grndwrk-device'] ? { error: 'Only comments can be sent here' } : unpaired)
    if (guessedTooOften() && !devices.byId(req.headers['x-grndwrk-device'])) return json(res, 429, { error: 'Too many wrong tries. Try again in ten minutes.' })
    const length = Number(req.headers['content-length'])
    if (!Number.isFinite(length)) return json(res, 411, { error: 'Send a Content-Length' })
    if (length > LAN_LIMIT) return json(res, 413, { error: 'Too large' })
    spent = spent.filter((s) => now - s.at < 3_600_000)
    if (spent.reduce((sum, s) => sum + s.bytes, 0) + length > HOUR_BUDGET) return json(res, 429, { error: 'Enough comments for this hour. Try again later.' })
    let body: Buffer
    try {
      body = await readAll(req, LAN_LIMIT)
    } catch {
      return json(res, 413, { error: 'Too large' })
    }
    const from = devices.verify(req.headers, 'POST', path, body, now)
    if (from === 'unsigned') return json(res, 401, unpaired)
    if (from === 'refused') {
      missed()
      return json(res, 401, { ...unpaired, error: 'grndwrk does not know this phone, or the request was changed. Pair it again.' })
    }
    spent.push({ at: now, bytes: length })
    if (!(await handleComments(req, res, lan, body))) json(res, 404, { error: 'Only comments can be sent here' })
  })
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
 * The project's pairing code, kept in `.grndwrk/lan-code` so a phone
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
 * However grndwrk ends (Ctrl+C, kill, kill -9, a crash, the terminal
 * closing), the pipe closes and the shell stops dns-sd, so no advert is left
 * pointing phones at a port where nothing listens.
 */
const ADVERT = 'dns-sd -R "$@" >/dev/null 2>&1 & pid=$!; trap \'kill $pid 2>/dev/null\' EXIT HUP INT TERM; read _ignored'

/**
 * Announce grndwrk on the network with Bonjour, so the iOS package finds
 * it without anyone typing an address. Uses macOS's own dns-sd. Returns a
 * function that stops the announcement, or null where dns-sd is missing.
 */
export function advertise(port: number, project: string): (() => void) | null {
  try {
    const name = `grndwrk ${project}`.slice(0, 63)
    const child = spawn('/bin/sh', ['-c', ADVERT, 'grndwrk-advert', name, '_grndwrk._tcp', 'local', String(port), `project=${project}`], {
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
