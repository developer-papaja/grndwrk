import type { GNode, ServerEvent } from '../../src/shared/types'

export async function fetchNodes(): Promise<GNode[]> {
  const res = await fetch('/api/nodes')
  if (!res.ok) throw new Error(`GET /api/nodes failed: ${res.status}`)
  return res.json()
}

export async function fetchProject(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/project')
  return res.ok ? res.json() : {}
}

/** Subscribe to server events. EventSource reconnects on its own after a drop. */
export function subscribe(handlers: {
  onEvent: (event: ServerEvent) => void
  onOpen: () => void
  onError: () => void
}): EventSource {
  const source = new EventSource('/api/events')
  source.onopen = handlers.onOpen
  source.onerror = handlers.onError
  source.onmessage = (msg) => handlers.onEvent(JSON.parse(msg.data))
  return source
}
