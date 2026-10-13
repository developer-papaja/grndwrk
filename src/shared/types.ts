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
  /** The screen this thought is about, a p_ id from screens/. Empty removes it. Kept as `screen:` in the file. */
  screen?: string
  /** A comment from the running product: the date the person marked it fixed, or empty to undo. Kept as `fixed:` in the file. */
  fixed?: string
  /** A comment from the running product: the date a fix was proposed, or empty when the fix turned out not to work. */
  proposed?: string
  /** A comment from the running product: the date its fix was built, ready to test, or empty when a test rejected it. */
  built?: string
}

export type ServerEvent =
  | { type: 'node:upsert'; node: GNode }
  | { type: 'node:delete'; id: string }
  | { type: 'file:change'; path: string }
  /** A comment pointed out on the phone, to be written in the browser. */
  | { type: 'node:open'; id: string }
  /** A phone on the network asks to send comments; the map asks the person to allow it. */
  | { type: 'pair:request'; request: PairRequest }
  /** That request was answered, or ran out. */
  | { type: 'pair:done'; id: string }

/** A phone asking to send comments, as the map shows it. */
export interface PairRequest {
  id: string
  /** What the phone calls itself, like "iPhone". */
  device: string
  /** The app the Comment button sits in. */
  app: string
  /** When it asked (ISO). */
  at: string
  /** The network address it asked from. */
  from: string
  /**
   * Four digits the phone shows too, worked out from its secret. The person
   * compares them before allowing, so a request from another device under
   * the same name is caught.
   */
  check: string
}

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
  /** The screen the gap is about, when /readiness judged one part. */
  screen?: string
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

export const FOUNDATION_STATUSES = ['done', 'partly', 'missing'] as const
export type FoundationStatus = (typeof FOUNDATION_STATUSES)[number]

/**
 * What a good project has, in a fixed order, with the group each sits in on
 * the Status page. Other ids are allowed and shown after these.
 */
export const FOUNDATIONS: { id: string; group: string; title: string }[] = [
  { id: 'purpose', group: 'purpose', title: 'What it is, who it is for, and what success is' },
  { id: 'claude_md', group: 'building with claude', title: 'Coding instructions in CLAUDE.md' },
  { id: 'code_standards', group: 'building with claude', title: 'Code standards: linting and formatting' },
  { id: 'claude_tools', group: 'building with claude', title: 'Skills and commands for the work' },
  { id: 'readme', group: 'documentation', title: 'A README: what it is and how to run it' },
  { id: 'code_docs', group: 'documentation', title: 'How the code is organized' },
  { id: 'design_philosophy', group: 'design', title: 'Design philosophy, written down' },
  { id: 'design_tokens', group: 'design', title: 'Design tokens: colors, type and spacing' },
]

/** One thing a good project has, checked by /readiness or /survey. In readiness/foundations.json. */
export interface Foundation {
  id: string
  group: string
  title: string
  status: FoundationStatus
  /** The files that show it. */
  seen_in: string[]
  /** What is lacking inside those files, one plain line each. */
  missing: string[]
  /** An instruction to give Claude Code in the product's repo to add what is missing. */
  suggestion: string
  /** A fuller draft in .groundwork/outputs/drafts/, by file name, when one was written. */
  draft?: string
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
  /** What the project has and lacks, empty until /readiness or /survey writes it. */
  foundations: Foundation[]
  /** Set when gaps.json could not be read, so the UI can say so. */
  error?: string
}

export const SCREEN_STATUSES = ['built', 'partial', 'planned'] as const
export type ScreenStatus = (typeof SCREEN_STATUSES)[number]

/**
 * One screen, page or view of the product, written by /sitemap from the code
 * (or by /brief for a product not built yet). Kept in .groundwork/screens/.
 */
export interface Screen {
  id: string
  title: string
  /** The screen this one sits under, for the tree. Empty at the top. */
  parent: string
  /** The variants it is in, from project.md's `variants:`. Empty means every variant. */
  in: string[]
  /** For a screen in one variant only: the screen that stands for it in the other. */
  replaced_by: string
  /** What the screen is for, in a sentence. */
  purpose: string
  /** Who it is meant for. `for:` in the file. */
  audience: string[]
  /** What the person is expected to do there. `does:` in the file. */
  tasks: string[]
  /** Screens reached from here. */
  leads_to: string[]
  /** Routes and source files that make up the screen. */
  code: string[]
  /**
   * Paths that open the screen in the running product, with real values for
   * any parameters, like /booking/42. Without it, a route in code: with no
   * parameters is opened.
   */
  open: string[]
  /**
   * What the running app calls the screen, when that is not in code: its
   * navigation title or view name, as comments and pictures from the app carry it.
   */
  seen_as: string[]
  /** Pictures this screen claims, as ios/App-2.jpg. They win over matching by name. */
  shots: string[]
  /** Stories that cover the screen. */
  stories: string[]
  status: ScreenStatus
  /** code when read from the code, inferred when Claude guessed. */
  source: string
  created: string
  body: string
  /** Set when the file could not be read. */
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
