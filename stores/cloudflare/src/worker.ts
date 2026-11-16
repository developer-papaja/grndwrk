/**
 * The Cloudflare side: each project is a Durable Object of its own, with its
 * own storage and tokens, so one project's token does nothing in another.
 * Everything the store does is in store.ts.
 *
 *   https://<worker>/<project>/v1/...         the protocol
 *   https://<worker>/<project>/admin/tokens   tokens, for whoever deployed it
 *   https://<worker>/<project>/               the page, and store.js for the staging site (page.ts)
 *   https://<worker>/v1/projects              the projects the token (or the Access login) may read
 */
import { access } from './access.js'
import { type Assets, page } from './page.js'
import { type Identify, type InboxLimits, parseOrigins, type Storage, Store } from './store.js'

export interface Env {
  OWNER_AUTH?: string
  /** Staging sites whose Comment button may call the store with a comment token: https origins, by commas or spaces. */
  COMMENT_ORIGINS?: string
  /** Optional, all three or none: see access.ts. */
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  ACCESS_ROLES?: string
  /** Optional, what one comment token may leave (store.ts, INBOX_LIMITS): whole numbers. */
  INBOX_FILES_PER_HOUR?: string
  INBOX_MB_PER_HOUR?: string
  INBOX_WAITING?: string
  INBOX_TOTAL?: string
  /** The folder `grndwrk store assets page` wrote, as the Worker's static assets (wrangler.toml). */
  ASSETS?: Assets
  STORE: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
}

/** A project's name in the address: lowercase letters, digits and dashes. */
export const PROJECT = /^\/([a-z0-9][a-z0-9-]{0,62})\//

/** The inbox limits the settings change; the rest stay as INBOX_LIMITS says. */
export function limitsOf(env: Env): Partial<InboxLimits> {
  const n = (v?: string) => (v && /^\d{1,12}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined)
  const out: Partial<InboxLimits> = {}
  const files = n(env.INBOX_FILES_PER_HOUR)
  const mb = n(env.INBOX_MB_PER_HOUR)
  const waiting = n(env.INBOX_WAITING)
  const total = n(env.INBOX_TOTAL)
  if (files) out.filesPerHour = files
  if (mb) out.bytesPerHour = mb * 1_000_000
  if (waiting) out.waiting = waiting
  if (total) out.total = total
  return out
}

/**
 * Cloudflare Access, when all three settings are there (access.ts). One per
 * isolate and settings, so its cache of Access's keys outlives a request:
 * otherwise every request with a made-up login would fetch the keys again.
 */
let accessCache: { key: string; identify: Identify } | null = null
const accessOf = (env: Env): Identify | undefined => {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.ACCESS_ROLES) return undefined
  const key = JSON.stringify([env.ACCESS_TEAM, env.ACCESS_AUD, env.ACCESS_ROLES])
  if (accessCache?.key !== key) accessCache = { key, identify: access({ team: env.ACCESS_TEAM, aud: env.ACCESS_AUD, roles: env.ACCESS_ROLES }) }
  return accessCache.identify
}

/**
 * `GET /v1/projects`, at the store's root: the projects this person may read,
 * for All projects on the page. Read only. A token belongs to one project and
 * says which (`gws_<project>.<secret>`; older tokens do not, and get 404, as a
 * store without the call), so that project's own object checks it and the list
 * holds that one. Through Access, every project the allow list gives the
 * person read or write, each reached with the same login.
 */
export async function listProjects(req: Request, store: Env['STORE'], identify?: Identify, roles = ''): Promise<Response> {
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  if (req.method !== 'GET') return json(405, { error: 'Not allowed' })
  const origin = new URL(req.url).origin
  const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  if (bearer) {
    const project = /^gws_([a-z0-9][a-z0-9-]{0,62})\./.exec(bearer)?.[1]
    if (!project) return json(404, { error: 'This token does not say its project. A new one does.' })
    const hello = await store.get(store.idFromName(project)).fetch(new Request(`${origin}/${project}/v1/hello`, { headers: { Authorization: `Bearer ${bearer}` } }))
    if (!hello.ok) return json(hello.status === 401 ? 401 : 404, { error: hello.status === 401 ? 'A valid token is required' : 'Not found' })
    const role = ((await hello.json()) as { role?: string }).role
    return json(200, { projects: role === 'read' || role === 'write' ? [{ name: project, url: `${origin}/${project}/` }] : [] })
  }
  if (!identify) return json(401, { error: 'A valid token is required' })
  const out: { name: string; url: string }[] = []
  for (const project of Object.keys(JSON.parse(roles || '{}') as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) continue
    const who = await identify(req, project)
    if (who?.role === 'read' || who?.role === 'write') out.push({ name: project, url: `${origin}/${project}/` })
  }
  return out.length ? json(200, { projects: out }) : json(401, { error: 'A valid login is required' })
}

export class StoreObject {
  private store: Store
  constructor(state: { storage: Storage }, env: Env) {
    const identify = accessOf(env)
    this.store = new Store(state.storage, { ownerAuth: env.OWNER_AUTH, identify, origins: parseOrigins(env.COMMENT_ORIGINS), limits: limitsOf(env) })
  }
  fetch(req: Request): Promise<Response> {
    const project = PROJECT.exec(new URL(req.url).pathname)?.[1] ?? ''
    return this.store.handle(req, project)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // https only, so a token never travels in the clear; http just on this machine, for `wrangler dev`.
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return Response.json({ error: 'https only' }, { status: 400 })
    if (url.pathname === '/v1/projects') return listProjects(req, env.STORE, accessOf(env), env.ACCESS_ROLES)
    // The page and the button: anything under the project's address but the protocol and admin.
    const under = /^\/([a-z0-9][a-z0-9-]{0,62})(?:$|\/(?!v1\/|admin\/))/.exec(url.pathname)?.[1]
    const shown = under ? await page(req, env.ASSETS, under, parseOrigins(env.COMMENT_ORIGINS)) : null
    if (shown) return shown
    const project = PROJECT.exec(url.pathname)?.[1]
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    return env.STORE.get(env.STORE.idFromName(project)).fetch(req)
  },
}
