export const NODE_TYPES = [
  'idea',
  'audience',
  'flow',
  'feature',
  'content',
  'design',
  'constraint',
  'question',
  'decision',
  'reference',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const STATUSES = ['open', 'settled', 'parked'] as const
export type Status = (typeof STATUSES)[number]

export interface GNode {
  id: string
  type: NodeType
  title: string
  /** Groups nodes sideways in the map. Empty when not set. */
  topic: string
  /** Which page of the map the node is on. Empty means the first page. */
  page: string
  altitude: number
  links: string[]
  status: Status
  created: string
  body: string
  /** Frontmatter keys we do not know about. Kept so they survive a write. */
  extra: Record<string, unknown>
  /** Set when the file could not be parsed. Such nodes are read only. */
  error?: string
  /** When the file last changed on disk (ISO). Read from the file system, never written. */
  modified?: string
}

/** Fields a client may send when creating or updating a node. */
export type NodeInput = Partial<Pick<GNode, 'type' | 'title' | 'topic' | 'page' | 'altitude' | 'links' | 'status' | 'body'>>

export type ServerEvent =
  | { type: 'node:upsert'; node: GNode }
  | { type: 'node:delete'; id: string }
  | { type: 'file:change'; path: string }

export const SEVERITIES = ['blocking', 'important', 'nice'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Something /readiness found missing. Shown in the map as a ghost card. */
export interface Gap {
  id: string
  area: string
  title: string
  why: string
  near: string[]
  severity: Severity
  page?: string
  topic?: string
  altitude?: number
  /** The node that answered this gap, set from the map. /readiness checks it again. */
  answered_by?: string
}

export type Verdict = 'ready to build' | 'ready to prototype' | 'not ready'

export interface Readiness {
  report: { verdict: Verdict | null; checked: string; body: string } | null
  gaps: Gap[]
  /** Set when gaps.json could not be read, so the UI can say so. */
  error?: string
}
