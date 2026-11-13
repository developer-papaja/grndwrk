import type { ServerResponse } from 'node:http'
import type { GNode, ServerEvent } from '../shared/types.js'

const clients = new Set<ServerResponse>()

export function subscribe(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  // Ask browsers to retry within a second, so an open tab finds a restarted server quickly.
  res.write('retry: 1000\n: connected\n\n')
  clients.add(res)
  tabSeen = Date.now()
  // Something a phone asked to open while every map tab was in the background: the first tab back in view opens it.
  if (held && Date.now() - held.at < HOLD_MS) res.write(`data: ${JSON.stringify(held.event)}\n\n`)
  held = null
  res.on('close', () => {
    clients.delete(res)
    tabSeen = Date.now()
  })
}

/** How many tabs are connected right now. */
export function clientCount(): number {
  return clients.size
}

/**
 * When a map tab was last there. A tab in the background has no live
 * connection (see ui/src/main.ts), so it says it is still there now and then.
 */
let tabSeen = 0
export function noteTab(gone = false): void {
  // A tab closing says so, so a request to open something then gets a new tab rather than waiting for none.
  tabSeen = gone ? 0 : Date.now()
}

/**
 * An event for the next tab that connects. A tab in the background has no
 * connection (macOS counts a browser window behind others as hidden too), so
 * opening a comment there waits until the person looks at the map, instead of
 * opening yet another tab or window.
 */
const HOLD_MS = 10 * 60_000
let held: { event: ServerEvent; at: number } | null = null
export function holdForTab(event: ServerEvent): void {
  held = { event, at: Date.now() }
}
export function tabAround(withinMs = 120_000): boolean {
  return clients.size > 0 || Date.now() - tabSeen < withinMs
}

export function broadcast(event: ServerEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(data)
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 25_000).unref()

/**
 * Keeps the last node state each browser was sent. After any change, from the
 * API or from disk, `sync` re-reads the nodes and broadcasts only what differs.
 * Our own writes coming back through the watcher therefore send nothing twice,
 * and a hand edit that changes links also updates the nodes on the other end.
 */
export class NodeSync {
  private sent = new Map<string, string>()

  constructor(private list: () => Promise<GNode[]>) {}

  async prime(): Promise<void> {
    for (const n of await this.list()) this.sent.set(n.id, JSON.stringify(n))
  }

  async sync(): Promise<void> {
    const nodes = await this.list()
    const seen = new Set<string>()
    for (const node of nodes) {
      seen.add(node.id)
      const json = JSON.stringify(node)
      if (this.sent.get(node.id) === json) continue
      this.sent.set(node.id, json)
      broadcast({ type: 'node:upsert', node })
    }
    for (const id of [...this.sent.keys()]) {
      if (seen.has(id)) continue
      this.sent.delete(id)
      broadcast({ type: 'node:delete', id })
    }
  }
}
