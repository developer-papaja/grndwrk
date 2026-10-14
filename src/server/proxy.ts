import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { connect as tlsConnect, getCACertificates, rootCertificates } from 'node:tls'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../root.js'
import { BadInput, type NodeStore } from '../store/nodes.js'
import type { NodeSync } from './events.js'
import { createFeedback, parseFeedback, testedOnWeb, webTestId, webTests } from './feedback.js'
import { openOnMac } from './comments.js'
import type { Sites } from './sites.js'

/**
 * Sits in front of the product's dev server and adds the comment overlay to
 * every page. Everything else passes through untouched, live reload included.
 * Nothing is written into the product's code: the overlay exists only here.
 */
export interface ProxyOptions {
  /** The product's dev server, for example http://localhost:5173, or https://shop.test under Herd or Valet. */
  target: URL
  /** Certificates to trust for an https target, instead of this Mac's. For tests. */
  ca?: string[]
  gwDir: string
  store: NodeStore
  nodes: NodeSync
  /** The map's address, to open a comment in it from the page. */
  uiUrl?: () => string
}

const PREFIX = '/__groundwork/'
const TAG = `<script src="${PREFIX}feedback.js" defer></script>`

/** What the overlay routes may take in an hour, from all pages together, like the LAN listener. */
const HOURLY = { comments: 120, bytes: 200_000_000 }

export interface OverlayCtx {
  gwDir: string
  store: NodeStore
  nodes: NodeSync
  /** Sites the person allowed. Without it only the page's own server (the proxy) may send. */
  sites?: Sites
  /** The map's address, to open a comment in it. */
  uiUrl?: () => string
  /** Kept per server: what came in during the current hour. */
  used?: { hour: number; comments: number; bytes: number }
}

/**
 * The overlay's own routes: the script, and the comments it sends. Served by
 * the proxy, and by the map's server for a page that loads the script itself
 * (a line in the product's layout, on its own address like https://shop.test).
 * Such a page is on another origin: only local development addresses may send
 * (CORS), never a site on the internet, and each site only once the person
 * allowed it in the map. Returns false for anything else.
 */
export async function handleOverlay(req: IncomingMessage, res: ServerResponse, ctx: OverlayCtx): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (!path.startsWith(PREFIX)) return false
  const name = path.slice(PREFIX.length)
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  // The page this server itself serves (the proxy): the same origin, nothing to ask.
  const sameOrigin = !!origin && origin === `http://${req.headers.host}`
  const cors: Record<string, string> = origin && isDevOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
  const script = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
  try {
    if ((name === 'feedback.js' || name === 'screenshot.js') && req.method === 'GET') {
      // Only for local development pages: a site on the internet that tries to
      // load them (to learn whether Groundwork runs here) gets nothing.
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer : ''
      if (referer && !isDevOrigin(referer)) {
        res.writeHead(403).end()
        return true
      }
    }
    if (name === 'feedback.js' && req.method === 'GET') {
      const js = await readFile(join(PACKAGE_ROOT, 'overlay', 'feedback.js'), 'utf8')
      res.writeHead(200, script).end(js)
      return true
    }
    if (name === 'screenshot.js' && req.method === 'GET') {
      // Draws part of the page into a picture for a comment. Wrapped so it
      // neither sees the page's module loader nor leaves a global behind but one.
      const lib = await readFile(join(PACKAGE_ROOT, 'dist', 'vendor', 'modern-screenshot.js'), 'utf8')
      const js = `;(function () { var exports, module, define; var globalThis = {};\n${lib}\n;window.__groundworkShot = globalThis.modernScreenshot })()\n`
      res.writeHead(200, script).end(js)
      return true
    }
    // Testing built fixes on the page they were made on. Only for the page's
    // own server (the proxy) or a site the person allowed, never asking, and
    // only that site's own comments that are ready to test.
    if (['tests', 'tested', 'show'].includes(name) && req.method !== 'OPTIONS') {
      await handleTests(req, res, ctx, name, origin, sameOrigin, cors)
      return true
    }
    if (['feedback', 'tested', 'show'].includes(name) && req.method === 'OPTIONS') {
      // The browser asks before a page on another origin sends JSON. Only local development addresses get a yes.
      if (!cors['Access-Control-Allow-Origin']) {
        res.writeHead(403).end()
        return true
      }
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }).end()
      return true
    }
    if (name === 'feedback' && req.method === 'POST') {
      if (origin && !sameOrigin) {
        if (!cors['Access-Control-Allow-Origin'] || !ctx.sites) {
          res.writeHead(403).end()
          return true
        }
        const site = await ctx.sites.check(origin)
        if (site !== 'allowed') {
          // Asked in the map: the button keeps the comment and sends it once allowed.
          res.writeHead(403, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ error: site === 'asked' ? 'Allow this site in Groundwork first' : 'Not allowed', ask: site === 'asked' }))
          return true
        }
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(415, cors).end()
        return true
      }
      const hour = Math.floor(Date.now() / 3_600_000)
      const used = ctx.used ?? (ctx.used = { hour, comments: 0, bytes: 0 })
      if (used.hour !== hour) Object.assign(used, { hour, comments: 0, bytes: 0 })
      if (used.comments >= HOURLY.comments || used.bytes >= HOURLY.bytes) {
        res.writeHead(429, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ error: 'Too many comments this hour' }))
        return true
      }
      const body = await readAll(req, 14_000_000)
      used.comments++
      used.bytes += body.length
      const input = parseFeedback(JSON.parse(body.toString('utf8')))
      const node = await createFeedback(ctx.gwDir, ctx.store, { ...input, platform: input.platform ?? 'Web' })
      await ctx.nodes.sync()
      res.writeHead(201, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ id: node.id, title: node.title }))
      return true
    }
    res.writeHead(404, cors).end()
  } catch (err) {
    const status = err instanceof BadInput || err instanceof SyntaxError ? 400 : 500
    if (status === 500) console.error(err)
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
  return true
}

/**
 * Testing built fixes on the page they were made on. Only for the page's own
 * server (the proxy, same origin) or a site the person allowed, never asking,
 * and only that site's own comments that are ready to test.
 */
async function handleTests(req: IncomingMessage, res: ServerResponse, ctx: OverlayCtx, name: string, origin: string, sameOrigin: boolean, cors: Record<string, string>): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }).end(JSON.stringify(body))
  }
  // No Origin: a same-origin GET on the proxy (the Host was checked before this).
  const site = origin || `http://${req.headers.host}`
  const allowed = sameOrigin || !origin || (!!cors['Access-Control-Allow-Origin'] && !!(await ctx.sites?.isAllowed(origin)))
  if (!allowed) return reply(403, { error: 'Not allowed' })
  if (name === 'tests' && req.method === 'GET') return reply(200, { tests: await webTests(ctx.store, site) })
  if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'Send JSON' })
  const body = JSON.parse((await readAll(req, 20_000)).toString('utf8'))
  if (name === 'tested') {
    const state = await testedOnWeb(ctx.store, site, body)
    if (!state) return reply(404, { error: 'No fix to test by that id' })
    await ctx.nodes.sync()
    return reply(200, { state })
  }
  const id = await webTestId(ctx.store, site, body?.id)
  if (!id || !ctx.uiUrl) return reply(404, { error: 'No fix to test by that id' })
  reply(200, { opened: await openOnMac(id, ctx.uiUrl()) })
}

/** A page on this machine, for development: localhost, 127.0.0.1, or a *.test or *.localhost name (Herd, Valet, Laravel). */
export function isDevOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return isLocalName(host) || /\.(test|localhost)$/.test(host)
  } catch {
    return false
  }
}

const isLocalName = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'

export function createProxy({ target, gwDir, store, nodes, ca, uiUrl }: ProxyOptions): Server {
  const overlay: OverlayCtx = { gwDir, store, nodes, uiUrl }
  const own = proxyName(target)
  const secure = target.protocol === 'https:'
  // Local https sites (Herd, Valet, mkcert) are signed by a certificate this
  // Mac trusts, which Node does not know by default. Trust what the Mac trusts;
  // certificates are still checked.
  const trusted = secure ? (ca ?? systemCertificates()) : undefined
  const server = createServer(async (req, res) => {
    if (!isLocal(req.headers.host, own)) return res.writeHead(403).end('Forbidden')
    const path = req.url ?? '/'
    if (await handleOverlay(req, res, overlay)) return
    forward(req, res)
  })

  function forward(req: IncomingMessage, res: ServerResponse) {
    const here = `http://${req.headers.host}`
    const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
    // The product sees requests from itself, as when visited directly.
    for (const k of ['origin', 'referer'] as const) {
      if (typeof headers[k] === 'string') headers[k] = (headers[k] as string).replace(here, target.origin)
    }
    const request = secure ? httpsRequest : httpRequest
    const upstream = request(
      // autoSelectFamily: localhost may be IPv6 or IPv4 depending on the dev server. Try both, like a browser.
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, autoSelectFamily: true, ...(secure ? { ca: trusted, servername: target.hostname } : {}) } as RequestOptions,
      (up) => {
        const out = { ...up.headers }
        // Redirects to the dev server stay on the proxy.
        if (typeof out.location === 'string') out.location = toProxy(out.location, target, here)
        if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map((c) => cookieForProxy(c))
        delete out['strict-transport-security']
        const html = (up.headers['content-type'] ?? '').includes('text/html')
        if (!html) {
          res.writeHead(up.statusCode ?? 502, out)
          up.pipe(res)
          return
        }
        readAll(up, 50_000_000).then(
          (body) => {
            // Links the product writes in full (Laravel's url() and route(), APP_URL) stay on the proxy too.
            const page = inject(toProxy(body.toString('utf8'), target, here))
            delete out['content-length']
            delete out['transfer-encoding']
            res.writeHead(up.statusCode ?? 200, { ...out, 'content-length': Buffer.byteLength(page) }).end(page)
          },
          () => res.writeHead(502).end(),
        )
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Groundwork could not reach ${target.origin}. Is your dev server running?`)
    })
    req.pipe(upstream)
  }

  // Live reload and other websockets go straight through.
  server.on('upgrade', (req, socket, head) => {
    if (!isLocal(req.headers.host, own)) return socket.destroy()
    const port = Number(target.port) || (secure ? 443 : 80)
    const open = (ready: () => void) =>
      secure
        ? tlsConnect({ port, host: target.hostname, servername: target.hostname, ca: trusted }, ready)
        : connect({ port, host: target.hostname, autoSelectFamily: true }, ready)
    const up = open(() => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const [k, v] = [req.rawHeaders[i], req.rawHeaders[i + 1]]
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? target.host : v}`)
      }
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })

  return server
}

/** What this Mac trusts and Node's own list, for local https sites. Node's list alone where the Mac's cannot be read. */
function systemCertificates(): string[] {
  try {
    return [...getCACertificates('system'), ...getCACertificates('default')]
  } catch {
    return [...rootCertificates]
  }
}

/**
 * The product's own address in a page or a header, written in full
 * (https://shop.test/cart, or https:\/\/shop.test in JSON), becomes the
 * proxy's, so following a link keeps the Comment button. Another port on the
 * same host (a Vite dev server) is left alone.
 */
export function toProxy(text: string, target: URL, here: string): string {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const host = escape(target.host)
  const scheme = escape(target.protocol.replace(/:$/, ''))
  const plain = new RegExp(`${scheme}://${host}(?![\\w.:-])`, 'g')
  const json = new RegExp(`${scheme}:\\\\/\\\\/${host}(?![\\w.:-])`, 'g')
  return text.replace(plain, here).replace(json, here.replace(/\//g, '\\/'))
}

/**
 * A cookie from the product, kept by the browser on the proxy's address: no
 * Domain (it is the product's, not localhost), and without Secure, since the
 * proxy is plain http on this Mac (SameSite=None needs Secure, so it becomes Lax).
 */
export function cookieForProxy(cookie: string): string {
  return cookie
    .split(';')
    .map((p) => p.trim())
    .filter((p) => !/^(domain|secure)(=|$)/i.test(p))
    .map((p) => (/^samesite=none$/i.test(p) ? 'SameSite=Lax' : p))
    .join('; ')
}

/** Put the overlay script on the page, once. */
export function inject(html: string): string {
  if (html.includes(TAG)) return html
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at < 0 ? html + TAG : html.slice(0, at) + TAG + html.slice(at)
}

function isLocal(host: string | undefined, own?: string): boolean {
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === own
}

/**
 * The name the proxy is opened on: the product's own, under `.localhost`
 * (https://shop.test becomes http://shop-test.localhost). Every `*.localhost`
 * name is this Mac, in browsers and in macOS. Cookies belong to a name, not a
 * port, so the product's login (which the proxy hands to the browser without
 * Secure) stays with this name and never reaches other servers on localhost.
 */
export function proxyName(target: URL): string {
  return `${target.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'app'}.localhost`
}

async function readAll(stream: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw new BadInput('Too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
