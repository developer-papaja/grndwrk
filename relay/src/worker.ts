/**
 * The Cloudflare side: each project's mailbox is a Durable Object of its
 * own, with its own storage, handling one request at a time. Everything
 * else is in relay.ts.
 */
import { Relay, type Store } from './relay.js'

interface Env {
  OWNER_AUTH?: string
  RELAY: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<number>
  list<T>(options: { prefix: string; limit?: number; start?: string }): Promise<Map<string, T>>
  deleteAll(): Promise<void>
}

export class RelayObject {
  private relay: Relay
  constructor(state: { storage: DurableObjectStorage }, env: Env) {
    this.relay = new Relay(state.storage as Store, env.OWNER_AUTH)
  }
  fetch(req: Request): Promise<Response> {
    return this.relay.handle(req)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // https only; http just on this machine, for trying it with `wrangler dev`.
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return new Response('https only', { status: 400 })
    if (url.pathname === '/v1/hello') return Response.json({ relay: 'grndwrk', version: 2 })
    const mailbox = /^\/v1\/([a-f0-9]{32})(?:\/|$)/.exec(url.pathname)?.[1]
    if (!mailbox) return new Response('Not found', { status: 404 })
    return env.RELAY.get(env.RELAY.idFromName(mailbox)).fetch(req)
  },
}
