import { readFile } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../root.js'
import { BadInput, type NodeStore } from '../store/nodes.js'
import type { NodeSync } from './events.js'
import { createFeedback, parseFeedback } from './feedback.js'

/**
 * Sits in front of the product's dev server and adds the comment overlay to
 * every page. Everything else passes through untouched, live reload included.
 * Nothing is written into the product's code: the overlay exists only here.
 */
export interface ProxyOptions {
  /** The product's dev server, for example http://localhost:5173. */
  target: URL
  gwDir: string
  store: NodeStore
  nodes: NodeSync
}

const PREFIX = '/__groundwork/'
const TAG = `<script src="${PREFIX}feedback.js" defer></script>`

export function createProxy({ target, gwDir, store, nodes }: ProxyOptions): Server {
  const server = createServer(async (req, res) => {
    if (!isLocal(req.headers.host)) return res.writeHead(403).end('Forbidden')
    const path = req.url ?? '/'
    if (path.startsWith(PREFIX)) return own(req, res, path.slice(PREFIX.length))
    forward(req, res)
  })

  async function own(req: IncomingMessage, res: ServerResponse, name: string) {
    try {
      if (name === 'feedback.js' && req.method === 'GET') {
        const js = await readFile(join(PACKAGE_ROOT, 'overlay', 'feedback.js'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(js)
        return
      }
      if (name === 'feedback' && req.method === 'POST') {
        // Same origin as the page, so only the page itself can send this.
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return void res.writeHead(415).end()
        const input = parseFeedback(JSON.parse((await readAll(req, 14_000_000)).toString('utf8')))
        const node = await createFeedback(gwDir, store, { ...input, platform: input.platform ?? 'Web' })
        await nodes.sync()
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: node.id, title: node.title }))
        return
      }
      res.writeHead(404).end()
    } catch (err) {
      const status = err instanceof BadInput || err instanceof SyntaxError ? 400 : 500
      if (status === 500) console.error(err)
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  }

  function forward(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
    const upstream = request(
      // autoSelectFamily: localhost may be IPv6 or IPv4 depending on the dev server. Try both, like a browser.
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, autoSelectFamily: true } as RequestOptions,
      (up) => {
        const out = { ...up.headers }
        // Redirects to the dev server stay on the proxy.
        if (typeof out.location === 'string') out.location = out.location.replace(target.origin, `http://${req.headers.host}`)
        const html = (up.headers['content-type'] ?? '').includes('text/html')
        if (!html) {
          res.writeHead(up.statusCode ?? 502, out)
          up.pipe(res)
          return
        }
        readAll(up, 50_000_000).then(
          (body) => {
            const page = inject(body.toString('utf8'))
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
    if (!isLocal(req.headers.host)) return socket.destroy()
    const up = connect({ port: Number(target.port) || 80, host: target.hostname, autoSelectFamily: true }, () => {
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

/** Put the overlay script on the page, once. */
export function inject(html: string): string {
  if (html.includes(TAG)) return html
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at < 0 ? html + TAG : html.slice(0, at) + TAG + html.slice(at)
}

function isLocal(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
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
