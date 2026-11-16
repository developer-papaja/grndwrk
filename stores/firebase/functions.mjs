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
 * @typedef {(name: string) => Promise<string | Uint8Array | null>} PageRead
 *   A file of the folder `grndwrk store assets page` wrote, by its name there, or null.
 */

/**
 * @param {{ backend: Backend, verify: Verify, page?: PageRead }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function storeFunction({ backend, verify, page }) {
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
    const shown = page && (request.method === 'GET' || request.method === 'HEAD') ? await pageAnswer(page, request, url, async (map) => backend.get(`projects/${map}`)) : null
    if (shown) return shown
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

      if (route === 'hello' && method === 'GET') return withSite(json(200, { ...(await store.hello()), writable: may === 'write', role: may, ...(may === 'comment' ? { commenter } : {}) }), may === 'comment' ? await siteOf(map, request) : '')

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

// The page and the Comment button, as grndwrk's src/shared-store/page.ts serves them. Keep them the same.
const PAGE_ROUTE = /^\/((?:[^/]+\/)*?)([A-Za-z0-9][A-Za-z0-9_-]{0,62})(|\/|\/index\.html|\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png)|\/store\.js|\/screenshot\.js)$/
const PAGE_TYPES = /** @type {Record<string, string>} */ ({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' })
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'"

/**
 * The page at a map's address, and store.js and screenshot.js for a page on
 * the map's staging site (by Referer). Null when the request is none of these,
 * or the map does not exist.
 * @param {PageRead} read
 * @param {Request} request
 * @param {URL} url
 * @param {(map: string) => Promise<Record<string, unknown> | null | undefined>} mapOf
 * @returns {Promise<Response | null>}
 */
async function pageAnswer(read, request, url, mapOf) {
  const m = PAGE_ROUTE.exec(url.pathname)
  if (!m) return null
  const [, prefix, map, rest] = m
  const doc = await mapOf(map).catch(() => null)
  if (!doc) return null
  if (rest === '') return new Response(null, { status: 301, headers: { Location: `${map}/` } })
  const name = rest === '/' ? 'index.html' : rest.slice(1)
  const headers = {
    'Content-Type': PAGE_TYPES[/\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': PAGE_CSP,
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  const body = (/** @type {string | Uint8Array | null} */ b) => (b === null ? null : typeof b === 'string' ? b : new TextDecoder().decode(b))
  if (name !== 'store.js' && name !== 'screenshot.js') {
    const b = await read(name)
    return b === null ? null : new Response(request.method === 'HEAD' ? null : typeof b === 'string' ? b : new Uint8Array(b), { headers })
  }
  let referer = ''
  try {
    referer = new URL(request.headers.get('referer') ?? '').origin
  } catch {}
  const site = typeof doc.site === 'string' && isHttpsOrigin(doc.site) && doc.site === referer ? doc.site : ''
  if (!site) return new Response('Only for the staging site', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
  if (name === 'screenshot.js') {
    const js = body(await read(name))
    return js === null ? null : new Response(js, { headers: { ...headers, Vary: 'Referer' } })
  }
  const [store, feedback] = [body(await read('overlay/store.js')), body(await read('overlay/feedback.js'))]
  if (store === null || feedback === null) return null
  // The map's address as the staging page reaches it; behind Hosting or another host name, the forwarded host.
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
  const config = { url: `https://${host}/${prefix}${map}/`, site }
  return new Response(`window.__grndwrkStoreConfig = ${JSON.stringify(config)};\n${store}\n${feedback}\n`, { headers: { ...headers, Vary: 'Referer' } })
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
