import type { GNode, NodeInput, Readiness, ServerEvent, Story } from '../../src/shared/types'

export const OFFLINE_MESSAGE = "Can't reach Groundwork. Is `groundwork` still running in your terminal?"

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // fetch only throws when no server answered at all.
    throw new Error(OFFLINE_MESSAGE)
  }
  if (!res.ok) {
    const msg = await res.json().then((j) => j.error, () => null)
    throw new Error(msg ?? `${method} ${path} failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const fetchNodes = () => request<GNode[]>('GET', '/api/nodes')
export const fetchProject = () => request<Record<string, unknown>>('GET', '/api/project').catch(() => ({}))
export const fetchStories = () => request<Story[]>('GET', '/api/stories')
export const fetchOutput = (name: 'brief.md' | 'CLAUDE.starter.md') =>
  request<{ text: string | null }>('GET', `/api/outputs/${encodeURIComponent(name)}`).then((r) => r.text)
export const fetchReadiness = () => request<Readiness>('GET', '/api/readiness')
export const markGapAnswered = (gapId: string, nodeId: string, enough = false) =>
  request<Readiness>('PATCH', `/api/gaps/${encodeURIComponent(gapId)}`, { answered_by: nodeId, ...(enough ? { enough } : {}) })
export const saveKickoff = (changes: Record<string, string | null>) => request<Record<string, unknown>>('PATCH', '/api/project', { kickoff: changes })
export const savePages = (pages: string[]) => request<Record<string, unknown>>('PATCH', '/api/project', { pages })
export const createNode = (input: NodeInput) => request<GNode>('POST', '/api/nodes', input)
export const updateNode = (id: string, input: NodeInput) =>
  request<GNode>('PATCH', `/api/nodes/${encodeURIComponent(id)}`, input)
/** Upload an image for a node. Returns the markdown that shows it in the notes. */
export async function uploadImage(id: string, file: Blob): Promise<{ markdown: string; url: string }> {
  let res: Response
  try {
    res = await fetch(`/api/nodes/${encodeURIComponent(id)}/files`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
  } catch {
    throw new Error(OFFLINE_MESSAGE)
  }
  if (!res.ok) throw new Error((await res.json().then((j) => j.error, () => null)) ?? `Upload failed (${res.status})`)
  return res.json()
}
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
