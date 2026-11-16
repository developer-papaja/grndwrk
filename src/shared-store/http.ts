import type { IncomingMessage, ServerResponse } from 'node:http'
import { bytesProblem, checkChanges, COMMENTER, checkVersion, CursorGone, type Hello, INBOX, MAX_INBOX, pathProblem, PROTOCOL, type Read, type Role, StoreBroke, type StoreClient, typeOf, type Written } from './protocol.js'

/** A store over HTTP: its address for this project, and this person's token. */
export class HttpStore implements StoreClient {
  private base: string

  constructor(
    url: string,
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    const u = new URL(url)
    // A token is never sent in the clear, except to this machine.
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('A store is reached over https (http only on this machine)')
    if (u.username || u.password) throw new Error('Put the token in --token, not in the address')
    u.hash = ''
    u.search = ''
    this.base = u.toString().replace(/\/?$/, '/')
  }

  private async call(method: string, path: string, init: { headers?: Record<string, string>; body?: Uint8Array } = {}) {
    const res = await this.fetcher(new URL(path, this.base), {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
      body: init.body as BodyInit | undefined,
      redirect: 'error',
    })
    if (res.status === 401) throw new StoreBroke('The store did not take the token (401)')
    return res
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text()
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new StoreBroke(`${res.status}: expected JSON, got ${text.slice(0, 80)}`)
    }
  }

  async hello(): Promise<Hello> {
    const res = await this.call('GET', 'v1/hello')
    if (!res.ok) throw new StoreBroke(`hello: ${res.status}`)
    const b = await this.json(res)
    if (b.protocol !== PROTOCOL) throw new StoreBroke(`hello: protocol ${String(b.protocol)}, grndwrk speaks ${PROTOCOL}`)
    const role = b.role === 'read' || b.role === 'write' || b.role === 'comment' ? b.role : b.writable === true ? 'write' : 'read'
    const commenter = role === 'comment' && typeof b.commenter === 'string' && COMMENTER.test(b.commenter) ? { commenter: b.commenter } : {}
    // A name from the store is shown in the map: one line of plain text, no control characters.
    const name = typeof b.name === 'string' && b.name.trim() ? { name: b.name.replace(/\p{Cc}/gu, '').trim().slice(0, 120) } : {}
    // names and site are passed on as they are: StoreSync decides what they are worth (an https origin only).
    const names = b.names === true ? { names: true } : {}
    const site = typeof b.site === 'string' && b.site.length <= 300 ? { site: b.site } : {}
    return { protocol: PROTOCOL, project: typeof b.project === 'string' ? b.project.slice(0, 200) : '', writable: b.writable === true, role, ...commenter, ...name, ...names, ...site }
  }

  async changes({ since, wait = 0 }: { since?: string; wait?: number } = {}) {
    const q = new URLSearchParams()
    if (since) q.set('since', since)
    if (wait) q.set('wait', String(Math.min(25, Math.max(0, Math.round(wait)))))
    const res = await this.call('GET', `v1/changes${q.size ? `?${q}` : ''}`)
    if (res.status === 410) throw new CursorGone(since ?? '')
    if (!res.ok) throw new StoreBroke(`changes: ${res.status}`)
    return checkChanges(await this.json(res))
  }

  async read(path: string): Promise<Read | null> {
    if (pathProblem(path)) throw new Error(pathProblem(path))
    const res = await this.call('GET', `v1/files/${path}`)
    if (res.status === 404) return null
    if (!res.ok) throw new StoreBroke(`read ${path}: ${res.status}`)
    const version = checkVersion(/^"(.*)"$/.exec(res.headers.get('etag') ?? '')?.[1])
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_INBOX) throw new StoreBroke(`read ${path}: too large`)
    // Believe the path, never the store's Content-Type: a picture must really be one.
    const problem = bytesProblem(path, bytes)
    if (problem) throw new StoreBroke(`read ${path}: ${problem}`)
    return { bytes, version, type: typeOf(path) }
  }

  async write(path: string, bytes: Uint8Array, { create, ifVersion }: { type: string; create?: boolean; ifVersion?: string }): Promise<Written> {
    const problem = pathProblem(path) || bytesProblem(path, bytes)
    if (problem) throw new Error(problem)
    const condition: Record<string, string> = create ? { 'If-None-Match': '*' } : { 'If-Match': `"${ifVersion ?? ''}"` }
    const res = await this.call('PUT', `v1/files/${path}`, { headers: { 'Content-Type': typeOf(path), ...condition }, body: bytes })
    const b = await this.json(res)
    if (res.status === 412) return { ok: false, version: b.version == null ? null : checkVersion(b.version) }
    if (res.status !== 200 && res.status !== 201) throw new StoreBroke(`write ${path}: ${res.status} ${String(b.error ?? '')}`)
    return { ok: true, version: checkVersion(b.version) }
  }

  async remove(path: string, ifVersion: string) {
    if (pathProblem(path)) throw new Error(pathProblem(path))
    const res = await this.call('DELETE', `v1/files/${path}`, { headers: { 'If-Match': `"${ifVersion}"` } })
    if (res.status === 404) return { ok: false as const, version: null, gone: true as const }
    const b = await this.json(res)
    if (res.status === 412) return { ok: false as const, version: b.version == null ? null : checkVersion(b.version) }
    if (!res.ok) throw new StoreBroke(`remove ${path}: ${res.status} ${String(b.error ?? '')}`)
    return { ok: true as const, version: '' }
  }
}

/**
 * The HTTP side of the protocol over any store client: what a store server
 * answers. grndwrk's tests run the check against it, and it is the model the
 * example stores in `stores/` follow. `token` decides who may read and write;
 * `origins` are the staging sites whose pages may make the comment calls
 * (CORS), as the protocol says: only those calls, only for a comment token.
 */
export function storeHandler(client: StoreClient, token: (bearer: string) => Role | { role: 'comment'; commenter: string } | null, { origins = [] }: { origins?: string[] } = {}) {
  return async (req: IncomingMessage, res: ServerResponse, prefix = '/') => {
    let cors: Record<string, string> = {}
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...headers }).end(JSON.stringify(body))
    }
    const url = new URL(req.url ?? '/', 'http://store')
    if (!url.pathname.startsWith(`${prefix}v1/`)) return send(404, { error: 'Not found' })
    const route = url.pathname.slice(prefix.length + 3)
    const origin = String(req.headers.origin ?? '')
    const commentCall = (method: string) => (route === 'hello' && method === 'GET') || (route.startsWith('files/inbox/') && method === 'PUT') || (route.startsWith('files/status/') && method === 'GET')
    const site = origin && origins.includes(origin) ? origin : ''
    const siteHeaders = { 'Access-Control-Allow-Origin': site, 'Access-Control-Expose-Headers': 'ETag', Vary: 'Origin' }
    if (req.method === 'OPTIONS') {
      if (!site || !commentCall(String(req.headers['access-control-request-method'] ?? ''))) return send(403, { error: 'Not allowed from this page' })
      res.writeHead(204, { ...siteHeaders, 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match', 'Access-Control-Max-Age': '600' }).end()
      return
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const who = token(bearer)
    // A page may read a 401 on a comment call, to ask the person to log in again.
    if (site && commentCall(req.method ?? '')) cors = siteHeaders
    if (!who) return send(401, { error: 'A valid token is required' })
    const may: Role = typeof who === 'string' ? who : who.role
    const commenter = typeof who === 'string' ? '' : who.commenter
    // Never CORS for what a read or write token does.
    if (may !== 'comment') cors = {}
    try {
      // A comment token learns its commenter here: the folder its comments go in, and its status file.
      if (route === 'hello' && req.method === 'GET') return send(200, { ...(await client.hello()), writable: may === 'write', role: may, ...(may === 'comment' ? { commenter } : {}) })
      // A commenter sees nothing of the map: only its own status, and new files in the inbox.
      if (may === 'comment') {
        const path = route.startsWith('files/') ? decodeURIComponent(route.slice(6)) : ''
        if (req.method === 'GET' && path === `status/${commenter}.json`) {
          const f = await client.read(path)
          if (!f) return send(404, { error: 'No status yet' })
          res.writeHead(200, { 'Content-Type': f.type, ETag: `"${f.version}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors }).end(Buffer.from(f.bytes))
          return
        }
        // Only under its own name: grndwrk knows who left a comment by its path, never by what the device wrote in it.
        if (!(req.method === 'PUT' && INBOX.exec(path)?.[1] === commenter && req.headers['if-none-match'] === '*')) return send(403, { error: 'This token may only leave comments' })
      }
      if (route === 'changes' && req.method === 'GET') {
        const since = url.searchParams.get('since') ?? undefined
        try {
          return send(200, await client.changes({ since, wait: Number(url.searchParams.get('wait') ?? 0) || 0 }))
        } catch (err) {
          if (err instanceof CursorGone) return send(410, { error: 'Unknown cursor: read everything again' })
          throw err
        }
      }
      if (!route.startsWith('files/')) return send(404, { error: 'Not found' })
      const path = decodeURIComponent(route.slice(6))
      const bad = pathProblem(path)
      if (bad) return send(400, { error: bad })
      if (req.method === 'GET') {
        const f = await client.read(path)
        if (!f) return send(404, { error: 'No such file' })
        res.writeHead(200, { 'Content-Type': f.type, ETag: `"${f.version}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(Buffer.from(f.bytes))
        return
      }
      if (may === 'read') return send(403, { error: 'This token may only read' })
      const match = /^"(.*)"$/.exec(String(req.headers['if-match'] ?? ''))?.[1]
      const create = req.headers['if-none-match'] === '*'
      if (req.method === 'PUT') {
        if (!create && match === undefined) return send(428, { error: 'Send If-Match or If-None-Match: *' })
        const chunks: Buffer[] = []
        let size = 0
        for await (const c of req) {
          size += (c as Buffer).length
          if (size > MAX_INBOX) return send(413, { error: 'Too large' })
          chunks.push(c as Buffer)
        }
        const bytes = new Uint8Array(Buffer.concat(chunks))
        const problem = bytesProblem(path, bytes)
        if (problem) return send(/at most/.test(problem) ? 413 : 415, { error: problem })
        const w = await client.write(path, bytes, { type: typeOf(path), create, ifVersion: match })
        return w.ok ? send(create ? 201 : 200, { version: w.version }) : send(412, { version: w.version })
      }
      if (req.method === 'DELETE') {
        if (match === undefined) return send(428, { error: 'Send If-Match' })
        const r = await client.remove(path, match)
        if (r.ok) return send(200, {})
        if ('gone' in r) return send(404, { error: 'No such file' })
        return send(412, { version: r.version })
      }
      return send(405, { error: 'Not allowed' })
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
