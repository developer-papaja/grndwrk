import { FOUNDATIONS, type Foundation, type FoundationStatus, type Screen, type Story } from './types.js'
import { screenTree, storiesForScreen } from './screens.js'

/** One line on the Status page: something a good project has, and whether this one does. */
export interface StatusRow {
  key: string
  title: string
  /** Empty when nothing has checked it yet. */
  status: FoundationStatus | ''
  /** What is lacking, or what is there, one line each. */
  detail: string[]
  seen_in: string[]
  suggestion: string
  draft?: string
  /** How deep a part sits in the sitemap. */
  depth?: number
  /** What the row's button does: open the purpose, a screen, or Focus. */
  open?: { kind: 'purpose' | 'screen' | 'focus'; id?: string }
  /** For a screen: its stories not marked done yet, `s_k3f9 (title)`. */
  openStories?: string[]
}

/**
 * The three kinds of work left, each asking something different of the person:
 * decide (answer questions and gaps, no code), build or confirm (screens whose
 * stories are not done: check them against the code, then build what is not
 * there), and set up (what a well-run project has, which Claude can add).
 */
export interface StatusKind {
  key: 'decide' | 'build' | 'setup'
  rows: StatusRow[]
  /** Missing: must be done. */
  must: number
  /** Partly there: should be done. */
  should: number
}

export interface StatusGroup {
  key: string
  name: string
  rows: StatusRow[]
}

export interface ProjectStatus {
  groups: StatusGroup[]
  done: number
  total: number
  /** Everything not done, most important first. */
  left: StatusRow[]
  /** Rows nothing has checked yet: /readiness has not run since they were added. */
  unchecked: number
  /** What is left, by the kind of work it is. Kinds with nothing left are left out. */
  kinds: StatusKind[]
}

const GROUPS: [string, string][] = [
  ['thinking', 'Open thinking'],
  ['purpose', 'Purpose'],
  ['parts', 'Parts'],
  ['building with claude', 'Building with Claude'],
  ['documentation', 'Documentation'],
  ['design', 'Design'],
]

/** A screen is done when built and every story on it is done, partly when anything is started. */
export function partStatus(screen: Screen, stories: Story[]): { status: FoundationStatus; detail: string } {
  // A story set aside ("Not now") is not left to do: it does not count here.
  const mine = storiesForScreen(screen, stories).filter((s) => !s.later)
  const done = mine.filter((s) => s.status === 'done').length
  const started = mine.filter((s) => s.status !== 'not-started').length
  const count = mine.length ? `${done} of ${mine.length} ${mine.length === 1 ? 'story' : 'stories'} done` : 'No story covers it'
  if (screen.status === 'planned') return started ? { status: 'partly', detail: `Planned. ${count}` } : { status: 'missing', detail: `Planned, not built. ${count}` }
  if (screen.status === 'partial') return { status: 'partly', detail: `Partially built. ${count}` }
  if (mine.length && done < mine.length) return { status: 'partly', detail: `Built. ${count}` }
  return { status: 'done', detail: `Built. ${count}` }
}

/**
 * Everything a good project has, done or not: open thinking, the purpose,
 * each part from the sitemap, and the foundations /readiness checked.
 */
export function buildStatus(input: {
  foundations: Foundation[]
  screens: Screen[]
  stories: Story[]
  /** The one line purpose in project.md. */
  purpose: string
  blocking: number
  questions: number
  /** Open gaps that are not blocking. */
  otherGaps?: number
}): ProjectStatus {
  const rows = new Map<string, StatusRow[]>(GROUPS.map(([k]) => [k, []]))
  const add = (group: string, row: StatusRow) => rows.set(group, [...(rows.get(group) ?? []), row])

  const open = input.blocking + input.questions
  const other = input.otherGaps ?? 0
  add('thinking', {
    key: 'thinking',
    title: open || other ? 'Questions and gaps waiting on you' : 'No questions or gaps waiting',
    status: open ? 'missing' : other ? 'partly' : 'done',
    detail: [
      ...(input.blocking ? [`${input.blocking} blocking ${input.blocking === 1 ? 'gap' : 'gaps'}`] : []),
      ...(input.questions ? [`${input.questions} ${input.questions === 1 ? 'question' : 'questions'} from Claude`] : []),
      ...(other ? [`${other} other ${other === 1 ? 'gap' : 'gaps'} worth answering`] : []),
    ],
    seen_in: [],
    suggestion: '',
    ...(open || other ? { open: { kind: 'focus' as const } } : {}),
  })

  const checked = new Map(input.foundations.map((f) => [f.id, f]))
  for (const f of [...FOUNDATIONS.map((k) => checked.get(k.id) ?? k), ...input.foundations.filter((f) => !FOUNDATIONS.some((k) => k.id === f.id))]) {
    const found = 'status' in f ? (f as Foundation) : null
    const row: StatusRow = {
      key: f.id,
      title: f.title,
      status: found?.status ?? '',
      detail: found?.missing ?? [],
      seen_in: found?.seen_in ?? [],
      suggestion: found?.suggestion ?? '',
      ...(found?.draft ? { draft: found.draft } : {}),
    }
    if (f.id === 'purpose') {
      row.open = { kind: 'purpose' }
      // Not checked yet: the purpose line in project.md still says something.
      if (!found) {
        row.status = input.purpose ? 'partly' : 'missing'
        row.detail = input.purpose ? [`"${input.purpose}". Not checked yet for who it is for and what success is.`] : ['No purpose written yet']
      }
    }
    add(found?.group ?? (f as { group: string }).group, row)
  }

  for (const { screen, depth } of screenTree(input.screens)) {
    const { status, detail } = partStatus(screen, input.stories)
    const notDone = storiesForScreen(screen, input.stories).filter((s) => s.status !== 'done' && !s.later)
    add('parts', {
      openStories: notDone.map((s) => `${s.id} (${s.title})`),
      key: `part:${screen.id}`,
      title: screen.title,
      depth,
      status,
      detail: [detail],
      seen_in: [],
      suggestion: '',
      open: { kind: 'screen', id: screen.id },
    })
  }

  const groups = [...rows.entries()]
    .filter(([, list]) => list.length)
    .map(([key, list]) => ({ key, name: GROUPS.find(([k]) => k === key)?.[1] ?? key.charAt(0).toUpperCase() + key.slice(1), rows: list }))
  const all = groups.flatMap((g) => g.rows)
  // Missing before partly; within each, the order of the groups.
  const left = [...all.filter((r) => r.status === 'missing'), ...all.filter((r) => r.status === 'partly')]
  const kindOf = (group: string): StatusKind['key'] => (group === 'thinking' ? 'decide' : group === 'parts' ? 'build' : 'setup')
  const kinds = (['decide', 'build', 'setup'] as const)
    .map((key) => {
      const mine = left.filter((r) => kindOf(groups.find((g) => g.rows.includes(r))!.key) === key)
      return { key, rows: mine, must: mine.filter((r) => r.status === 'missing').length, should: mine.filter((r) => r.status === 'partly').length }
    })
    .filter((k) => k.rows.length)
  return { groups, done: all.filter((r) => r.status === 'done').length, total: all.length, left, unchecked: all.filter((r) => !r.status).length, kinds }
}
