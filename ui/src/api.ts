import type { GNode, NodeInput, PairRequest, Persona, PersonaInSegment, PersonaList, PersonaSection, Readiness, Screen, Segment, ServerEvent, Story } from '../../src/shared/types'

export const OFFLINE_MESSAGE = "Can't reach grndwrk. Is `grndwrk` still running in your terminal?"

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
export interface DocFinding { id: string; title: string; status: string; missing: string[]; suggestion: string; section?: string }
export interface Doc { path: string; exists: boolean; findings: DocFinding[]; draft?: string; blocked?: string }
export const fetchDocs = () => request<Doc[]>('GET', '/api/docs').catch(() => [] as Doc[])
export const fetchDoc = (path: string) => request<{ path: string; text: string; exists: boolean; draft?: string }>('GET', `/api/docs/file?path=${encodeURIComponent(path)}`)
export const openDocInEditor = (path: string) => request<{ opened: boolean }>('POST', '/api/docs/open', { path })
export const createStory = (input: { title: string; from: string[]; body?: string }) => request<Story>('POST', '/api/stories', input)
export const updateStory = (id: string, edit: { title?: string; status?: string; body?: string; later?: string | null }) => request<Story>('PATCH', `/api/stories/${encodeURIComponent(id)}`, edit)
export const fetchScreens = () => request<Screen[]>('GET', '/api/screens')
export const fetchPersonas = () => request<Persona[]>('GET', '/api/personas')
export const createPersona = (input: { name: string; summary?: string }) => request<Persona>('POST', '/api/personas', input)
export type PersonaInput = Partial<Record<'name' | 'summary' | 'tier' | 'technical' | 'frequency' | 'learning_curve' | PersonaSection | 'body', string>> &
  Partial<Record<PersonaList, string[]>> & { segments?: Record<string, PersonaInSegment>; confirmed?: boolean }
export const updatePersona = (id: string, input: PersonaInput) =>
  request<Persona>('PATCH', `/api/personas/${encodeURIComponent(id)}`, input)
export const deletePersona = (id: string) => request<void>('DELETE', `/api/personas/${encodeURIComponent(id)}`)
export const settleName = (name: string, to: string) => request<{ persona: Persona | null }>('POST', '/api/personas/settle', { name, to })
export const fetchSegments = () => request<Segment[]>('GET', '/api/segments')
export const createSegment = (name: string) => request<Segment>('POST', '/api/segments', { name })
export type SegmentInput = { name?: string; type?: string; industry?: string; size_min?: number; size_max?: number; admins?: string[]; body?: string }
export const updateSegment = (id: string, input: SegmentInput) => request<Segment>('PATCH', `/api/segments/${encodeURIComponent(id)}`, input)
/** The person's own answer in a thread: taken back just after it was given, or changed later (keep the old one beside it, or overwrite it). */
export type ThreadOwner = { kind: 'node'; item: GNode } | { kind: 'screen'; item: Screen } | { kind: 'persona'; item: Persona } | { kind: 'segment'; item: Segment }
export const undoEntry = (owner: string, run: string, text: string) =>
  request<ThreadOwner & { run: null }>('POST', `/api/threads/${encodeURIComponent(owner)}/${encodeURIComponent(run)}/undo`, { text })
export const changeEntry = (owner: string, run: string, text: string, keep: boolean) =>
  request<ThreadOwner & { run: string }>('PATCH', `/api/threads/${encodeURIComponent(owner)}/${encodeURIComponent(run)}`, { text, keep })
export const deleteSegment = (id: string) => request<void>('DELETE', `/api/segments/${encodeURIComponent(id)}`)
export const updateScreen = (id: string, input: { purpose?: string; audience?: string[]; tasks?: string[]; body?: string; hidden?: boolean; features?: string[]; part?: string }) =>
  request<Screen>('PATCH', `/api/screens/${encodeURIComponent(id)}`, input)
export const fetchOutput = (name: 'brief.md' | 'CLAUDE.starter.md' | 'survey.md' | 'personas.md') =>
  request<{ text: string | null }>('GET', `/api/outputs/${encodeURIComponent(name)}`).then((r) => r.text)
export const fetchDraft = (name: string) => request<{ text: string | null }>('GET', `/api/drafts/${encodeURIComponent(name)}`).then((r) => r.text)
export const fetchReadiness = () => request<Readiness>('GET', '/api/readiness')
export const markGapAnswered = (gapId: string, nodeId: string, enough = false) =>
  request<Readiness>('PATCH', `/api/gaps/${encodeURIComponent(gapId)}`, { answered_by: nodeId, ...(enough ? { enough } : {}) })
export const setFocusLater = (id: string, later: boolean) => request<Readiness>('PATCH', `/api/focus/${encodeURIComponent(id)}`, { later })
export const saveKickoff = (changes: Record<string, string | null>) => request<Record<string, unknown>>('PATCH', '/api/project', { kickoff: changes })
export const saveProjectFields = (fields: { start?: 'new' | 'existing'; purpose?: string; name?: string; initials?: string; color?: string }) => request<Record<string, unknown>>('PATCH', '/api/project', fields)
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
export interface Shot {
  platform: 'web' | 'ios'
  key: string
  /** How a screen names it in shots: ios/App-2.jpg. */
  file: string
  url: string
  taken: string
  /** What the screen showed, from the app. */
  texts?: string[]
  /** A picture pasted into a reply or an answer, not one of a screen. */
  pasted?: boolean
}
export const fetchShots = () => request<Shot[]>('GET', '/api/shots').catch(() => [] as Shot[])
/** Put a picture on a screen, taking it off any other; an empty screen only takes it off. */
export const placeShot = (file: string, screen: string) => request<Screen[]>('POST', '/api/shots/place', { file, screen })
export const fetchRuntime = () => request<{ app: string | null; proxied: boolean }>('GET', '/api/runtime').catch(() => ({ app: null, proxied: false }))
export const fetchPairRequests = () => request<PairRequest[]>('GET', '/api/pair').catch(() => [] as PairRequest[])
export const answerPairRequest = (id: string, allow: boolean) => request<{ ok: true }>('POST', `/api/pair/${encodeURIComponent(id)}`, { allow })
export interface AllowedSite { origin: string; kept: boolean }
export const fetchSites = () => request<{ asking: string[]; allowed: AllowedSite[] }>('GET', '/api/sites').catch(() => ({ asking: [] as string[], allowed: [] as AllowedSite[] }))
export const answerSiteRequest = (origin: string, allow: boolean) => request<{ allowed: AllowedSite[] }>('POST', '/api/sites', { origin, allow })
export const removeSite = (origin: string) => request<{ allowed: AllowedSite[] }>('POST', '/api/sites', { origin, remove: true })
export const markTested = (id: string, works: boolean, note: string) =>
  request<{ state: 'fixed' | 'incoming'; node: GNode }>('POST', `/api/nodes/${encodeURIComponent(id)}/tested`, { works, note })
export interface RelayInfo {
  connected: boolean
  deployed?: boolean
  url?: string
  phones?: { id: string; name: string; joined: string }[]
  invites?: { id: string; name: string; expires: number }[]
  waiting?: { invite: string; name: string; digits: string }[]
  site?: string
  error?: string
}
/** Who is on this Mac (git's user.name), and each thought's first author in git, by id. */
export const fetchAuthors = () => request<{ me: string; first: Record<string, string> }>('GET', '/api/authors').catch(() => ({ me: '', first: {} }))
export const fetchRelay = () => request<RelayInfo>('GET', '/api/relay').catch(() => ({ connected: false }) as RelayInfo)
export const inviteLinkAgain = (id: string) => request<{ id: string; name: string; link: string }>('POST', `/api/relay/invites/${id}/link`, {})
export const inviteColleague = (name: string) => request<{ id: string; name: string; link: string }>('POST', '/api/relay/invites', { name })
export const answerJoin = (invite: string, allow: boolean) => request<RelayInfo>('POST', `/api/relay/joins/${invite}`, { allow })
export const removeFromRelay = (kind: 'phones' | 'invites', id: string) => request<RelayInfo>('DELETE', `/api/relay/${kind}/${id}`)
/** A comment through the relay was opened here: the server writes `seen:` on it the first time. */
export const markSeen = (id: string) => request<{ seen: boolean }>('POST', `/api/nodes/${encodeURIComponent(id)}/seen`, {})
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

// Questions waiting for someone's answer (src/store/waiting.ts).
export interface WaitingState { personal_info: 'yes' | 'no' | null; people: string[]; items: { key: string; on: string; question: string; since: string; for?: string }[] }
export const fetchWaiting = () => request<WaitingState>('GET', '/api/waiting')
export const saveWaiting = (input: { on: string; question: string; for?: string | null; clear?: boolean }) => request<WaitingState>('POST', '/api/waiting', input)
export const savePersonalInfo = (value: 'yes' | 'no') => request<WaitingState>('POST', '/api/waiting/personal-info', { value })
