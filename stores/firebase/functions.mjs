// @ts-check
/**
 * The store over HTTP, as docs/store-protocol.md says, on web Request and
 * Response, so it runs the same in Cloud Functions (index.mjs) and in tests.
 *
 * Who may do what: the Bearer token is either a Firebase Auth ID token or a
 * store key (`gk_...`, for grndwrk on a Mac and for phones, which keep one
 * token for good while an ID token lasts an hour). Either names a user; the
 * user's role on a map is `projects/{map}/members/{uid}`:
 *   { role: 'write' | 'read' | 'comment', commenter?: 'dev_ab12cd34', name?: 'Front desk iPad' }
 * A commenter without `commenter` uses its uid. To use your own login, replace `verify`.
 *
 * A staging site's Comment button calls the store from the browser: the map's
 * `site` (`projects/{map}`, an https origin such as https://staging.vetclinic.example)
 * gets CORS, and only for what a comment token does: hello, PUT inbox/... and GET status/....
 * A 401 or 403 on those calls carries it too, so the page can say why.
 */
import { createHash } from 'node:crypto'
import { bytesProblem, COMMENTER, CursorGone, INBOX, MAX_INBOX, pathProblem, storeOver, typeOf } from './adapter.mjs'

/**
 * @typedef {import('./adapter.mjs').Backend} Backend
 * @typedef {(token: string) => Promise<{ uid: string } | null>} Verify
 *   Who a Firebase ID token belongs to (firebase-admin's verifyIdToken), or null.
 */

/** @param {string} key */
export const keyHash = (key) => createHash('sha256').update(key).digest('hex')

/**
 * @param {{ backend: Backend, verify: Verify }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function storeFunction({ backend, verify }) {
  /**
   * @param {number} status
   * @param {unknown} body
   */
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  /**
   * The user behind a token. A store key is kept only as its hash, per map.
   * @param {string} map
   * @param {string} bearer
   */
  const userOf = async (map, bearer) => {
    if (bearer.startsWith('gk_')) {
      const k = await backend.get(`projects/${map}/keys/${keyHash(bearer)}`)
      return typeof k?.uid === 'string' ? { uid: k.uid } : null
    }
    return verify(bearer).catch(() => null)
  }

  /**
   * The map's staging site when this request comes from it, or ''.
   * @param {string} map
   * @param {Request} request
   */
  const siteOf = async (map, request) => {
    const origin = request.headers.get('origin')
    if (!origin) return ''
    const site = (await backend.get(`projects/${map}`))?.site
    return typeof site === 'string' && isHttpsOrigin(site) && site === origin ? site : ''
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  const answer = async (request) => {
    const url = new URL(request.url)
    const m = ROUTE.exec(url.pathname)
    if (!m) return json(404, { error: 'Not found' })
    const [, map, route] = m
    // The preflight carries no token: answer it for the comment calls only, and only for the map's site.
    if (request.method === 'OPTIONS') {
      const site = await siteOf(map, request)
      if (!site || !commentCall(route, request.headers.get('access-control-request-method') ?? '')) return json(403, { error: 'Not allowed' })
      return new Response(null, { status: 204, headers: { ...cors(site), 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match', 'Access-Control-Max-Age': '600' } })
    }
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
    if (!bearer) return json(401, { error: 'A valid token is required' })
    try {
      const user = await userOf(map, bearer)
      const member = user ? await backend.get(`projects/${map}/members/${user.uid}`) : null
      /** @type {'read' | 'write' | 'comment' | null} */
      const may = member && ['read', 'write', 'comment'].includes(member.role) ? member.role : null
      if (!user || !may) return json(401, { error: 'A valid token of a member of this map is required' })
      const commenter = may !== 'comment' ? '' : typeof member?.commenter === 'string' ? member.commenter : user.uid
      const store = storeOver(backend, map)
      const method = request.method

      if (route === 'hello' && method === 'GET') return withSite(json(200, { ...(await store.hello()), writable: may === 'write', role: may }), may === 'comment' ? await siteOf(map, request) : '')

      let path = ''
      if (route.startsWith('files/')) {
        try {
          path = decodeURIComponent(route.slice(6))
        } catch {
          return json(400, { error: 'Not a path' })
        }
      }

      // A commenter sees nothing of the map: only its own status, and new files in its own inbox folder.
      if (may === 'comment') {
        const site = await siteOf(map, request)
        if (!COMMENTER.test(commenter)) return withSite(json(403, { error: 'This member has no commenter id' }), site)
        if (method === 'GET' && path === `status/${commenter}.json`) {
          const f = await store.read(path)
          return withSite(f ? file(f) : json(404, { error: 'No status yet' }), site)
        }
        if (!(method === 'PUT' && INBOX.exec(path)?.[1] === commenter && request.headers.get('if-none-match') === '*')) return json(403, { error: 'This token may only leave comments' })
        const body = await bodyOf(request)
        if (!body) return withSite(json(413, { error: 'Too large' }), site)
        const comment = commentOf(body)
        if (!comment) return withSite(json(400, { error: 'A comment is a JSON object' }), site)
        // The name the store knows wins over whatever the device wrote.
        if (typeof member?.name === 'string' && member.name) comment.from = member.name
        const bytes = new TextEncoder().encode(JSON.stringify(comment))
        const problem = bytesProblem(path, bytes)
        if (problem) return withSite(json(413, { error: problem }), site)
        const w = await store.write(path, bytes, { type: 'application/json', create: true })
        return withSite(w.ok ? json(201, { version: w.version }) : json(412, { version: w.version }), site)
      }

      if (route === 'changes' && method === 'GET') {
        try {
          return json(200, await store.changes({ since: url.searchParams.get('since') ?? undefined }))
        } catch (err) {
          if (err instanceof CursorGone) return json(410, { error: 'Unknown cursor: read everything again' })
          throw err
        }
      }
      if (!route.startsWith('files/')) return json(404, { error: 'Not found' })
      const bad = pathProblem(path)
      if (bad) return json(400, { error: bad })
      if (method === 'GET') {
        const f = await store.read(path)
        return f ? file(f) : json(404, { error: 'No such file' })
      }
      if (method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'Not allowed' })
      if (may !== 'write') return json(403, { error: 'This token may only read' })
      const match = /^"(.*)"$/.exec(request.headers.get('if-match') ?? '')?.[1]
      const create = request.headers.get('if-none-match') === '*'
      if (method === 'PUT') {
        if (!create && match === undefined) return json(428, { error: 'Send If-Match or If-None-Match: *' })
        const bytes = await bodyOf(request)
        if (!bytes) return json(413, { error: 'Too large' })
        const problem = bytesProblem(path, bytes)
        if (problem) return json(/at most/.test(problem) ? 413 : 415, { error: problem })
        if (INBOX.test(path) && !commentOf(bytes)) return json(400, { error: 'A comment is a JSON object' })
        // The path decides the type; a Content-Type sent with the write is only a hint.
        const w = await store.write(path, bytes, { type: typeOf(path), create, ifVersion: match })
        return w.ok ? json(create ? 201 : 200, { version: w.version }) : json(412, { version: w.version })
      }
      if (match === undefined) return json(428, { error: 'Send If-Match' })
      const r = await store.remove(path, match)
      if (r.ok) return json(200, {})
      if ('gone' in r) return json(404, { error: 'No such file' })
      return json(412, { version: r.version })
    } catch (err) {
      console.error(err)
      return json(500, { error: 'The store failed; see the function log' })
    }
  }
  return async (request) => {
    const res = await answer(request)
    if ((res.status !== 401 && res.status !== 403) || request.method === 'OPTIONS' || res.headers.has('access-control-allow-origin')) return res
    const m = ROUTE.exec(new URL(request.url).pathname)
    if (!m || !commentCall(m[2], request.method)) return res
    return withSite(res, await siteOf(m[1], request).catch(() => ''))
  }
}

/** The map's id is the part before the first /v1/: .../store/clinic/v1/hello */
const ROUTE = /^\/(?:[^/]+\/)*?([A-Za-z0-9][A-Za-z0-9_-]{0,62})\/v1\/(.*)$/

/**
 * Whether this is one of the calls a staging page makes with a comment token.
 * @param {string} route
 * @param {string} method
 */
const commentCall = (route, method) => (route === 'hello' ? method === 'GET' : route.startsWith('files/inbox/') ? method === 'PUT' : route.startsWith('files/status/') ? method === 'GET' : false)

/** @param {string} site */
const cors = (site) => ({ 'Access-Control-Allow-Origin': site, Vary: 'Origin' })

/**
 * A comment-token answer, with CORS when it came from the map's staging site.
 * @param {Response} res
 * @param {string} site
 */
function withSite(res, site) {
  if (site) for (const [k, v] of Object.entries(cors(site))) res.headers.set(k, v)
  return res
}

/** @param {string} s */
export const isHttpsOrigin = (s) => {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && u.origin === s
  } catch {
    return false
  }
}

/**
 * An inbox file's body as an object, or null when it is not a JSON object.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown> | null}
 */
export function commentOf(bytes) {
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * A file's bytes, never to be run or rendered by a browser.
 * @param {{ bytes: Uint8Array, version: string, type: string }} f
 */
const file = (f) =>
  new Response(new Uint8Array(f.bytes), {
    status: 200,
    headers: { 'Content-Type': f.type, ETag: `"${f.version}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  })

/**
 * The request's bytes, or null when larger than any file a store keeps.
 * @param {Request} request
 */
async function bodyOf(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_INBOX) return null
  const bytes = new Uint8Array(await request.arrayBuffer())
  return bytes.length > MAX_INBOX ? null : bytes
}
