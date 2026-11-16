/**
 * The Cloudflare side: each project is a Durable Object of its own, with its
 * own storage and tokens, so one project's token does nothing in another.
 * Everything the store does is in store.ts.
 *
 *   https://<worker>/<project>/v1/...         the protocol
 *   https://<worker>/<project>/admin/tokens   tokens, for whoever deployed it
 */
import { access } from './access.js'
import { type Storage, Store } from './store.js'

export interface Env {
  OWNER_AUTH?: string
  /** Optional, all three or none: see access.ts. */
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  ACCESS_ROLES?: string
  STORE: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
}

/** A project's name in the address: lowercase letters, digits and dashes. */
export const PROJECT = /^\/([a-z0-9][a-z0-9-]{0,62})\//

export class StoreObject {
  private store: Store
  constructor(state: { storage: Storage }, env: Env) {
    const identify = env.ACCESS_TEAM && env.ACCESS_AUD && env.ACCESS_ROLES ? access({ team: env.ACCESS_TEAM, aud: env.ACCESS_AUD, roles: env.ACCESS_ROLES }) : undefined
    this.store = new Store(state.storage, { ownerAuth: env.OWNER_AUTH, identify })
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
    const project = PROJECT.exec(url.pathname)?.[1]
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    return env.STORE.get(env.STORE.idFromName(project)).fetch(req)
  },
}
