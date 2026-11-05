/**
 * The Cloudflare side: every request goes to one Durable Object, which
 * keeps the envelopes in its own storage and handles one request at a time.
 * Everything else is in relay.ts.
 */
import { Relay, type Store } from './relay.js'

interface Env {
  TEAM_AUTH?: string
  RELAY: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<number>
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>
}

export class RelayObject {
  private relay: Relay
  constructor(state: { storage: DurableObjectStorage }, env: Env) {
    this.relay = new Relay(state.storage as Store, env.TEAM_AUTH)
  }
  fetch(req: Request): Promise<Response> {
    return this.relay.handle(req)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).protocol !== 'https:') return new Response('https only', { status: 400 })
    return env.RELAY.get(env.RELAY.idFromName('team')).fetch(req)
  },
}
