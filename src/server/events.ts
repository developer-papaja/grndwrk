import type { ServerResponse } from 'node:http'
import type { GNode, ServerEvent } from '../shared/types.js'

const clients = new Set<ServerResponse>()

export function subscribe(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  clients.add(res)
  res.on('close', () => clients.delete(res))
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
