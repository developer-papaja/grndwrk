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
export type NodeInput = Partial<Pick<GNode, 'type' | 'title' | 'topic' | 'page' | 'altitude' | 'links' | 'status' | 'body'>> & {
  /** On create: the id of the gap this thought answers. Kept as `answers:` in the file. */
  answers?: string
}

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
  /** Set with answered_by when the person said "Enough for now": the gap is closed for good. */
  enough?: boolean
  /** Answers Claude proposes, written by /readiness, so the person can start from one. */
  suggestions?: { title: string; why: string }[]
}

export type Verdict = 'ready to build' | 'ready to prototype' | 'not ready'

/** The fixed design checks, in the order the scorecard shows them. */
export const DESIGN_ITEMS = [
  'design docs',
  'colors as tokens',
  'typography',
  'spacing scale',
  'radius and shadows',
  'shared components',
  'icons',
  'references',
  'accessibility',
  // Only when a repo holds more than one app: are colors, type and icons defined once and kept in step?
  'shared across platforms',
] as const
export type DesignStatus = 'found' | 'partly' | 'missing'

/** One line of the design scorecard, written by /survey and /readiness. */
export interface DesignCheck {
  /** Which app this is about, when a repo holds more than one: "iOS", "Android", "Web", or "All". */
  platform?: string
  item: string
  status: DesignStatus
  note: string
  seen_in: string[]
}

export interface Readiness {
  report: {
    verdict: Verdict | null
    checked: string
    body: string
    /** Gaps closed and gaps added since the check before, by title. */
    closed: string[]
    added: string[]
  } | null
  gaps: Gap[]
  /** The design scorecard, empty until /survey or /readiness writes it. */
  design: DesignCheck[]
  /** Set when gaps.json could not be read, so the UI can say so. */
  error?: string
}

export const STORY_STATUSES = ['not-started', 'partial', 'done'] as const
export type StoryStatus = (typeof STORY_STATUSES)[number]

/** A user story written by /brief. Kept in .groundwork/stories/, one file each. */
export interface Story {
  id: string
  title: string
  status: StoryStatus
  /** The map nodes the story came from. Every story needs at least one. */
  from: string[]
  /** Routes or component paths in the product, filled in while building. */
  applies_to: string[]
  created: string
  body: string
  /** Set when the file is broken or misses something required. */
  error?: string
}
