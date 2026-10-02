import type { GNode, NodeInput, ServerEvent } from '../../src/shared/types'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const msg = await res.json().then((j) => j.error, () => null)
    throw new Error(msg ?? `${method} ${path} failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const fetchNodes = () => request<GNode[]>('GET', '/api/nodes')
export const fetchProject = () => request<Record<string, unknown>>('GET', '/api/project').catch(() => ({}))
export const createNode = (input: NodeInput) => request<GNode>('POST', '/api/nodes', input)
export const updateNode = (id: string, input: NodeInput) =>
  request<GNode>('PATCH', `/api/nodes/${encodeURIComponent(id)}`, input)
export const deleteNode = (id: string) => request<void>('DELETE', `/api/nodes/${encodeURIComponent(id)}`)

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
