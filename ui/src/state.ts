import Alpine from 'alpinejs'
import type { DesignCheck, Gap, GNode, NodeInput, NodeType, Readiness, Screen, Status, Story } from '../../src/shared/types'
import { NODE_TYPES, STATUSES } from '../../src/shared/types'
import { createNode, deleteNode, fetchOutput, fetchReadiness, fetchScreens, fetchStories, markGapAnswered, saveKickoff, savePages, updateNode, updateScreen, uploadImage } from './api'
import { BOX, commentsForScreen, layoutSitemap, screenTree, storiesForScreen } from '../../src/shared/screens'
import { mergePages, pageOf, samePage } from '../../src/shared/pages'
import { appendEntry, openQuestions, questionOptions, replaceNotes, splitBody, type Entry } from '../../src/shared/thread'
import { parseAreas, type Area } from '../../src/shared/report'
import { parseCapture, sameTitle } from './capture'
import { marked } from 'marked'
import { ALTITUDE_WORDS, displayName, topicColumns, topicKey } from './layout'
import { TYPE_COLORS } from './palette'
import { flatten, groupForList, type ListGroup } from './list'
import { buildBoard, buildOutline, firstLine, MAP_LAYOUTS, type Board, type MapLayout, type OutlineSection } from './board'

export type View = 'focus' | 'map' | 'sitemap' | 'readiness' | 'deliverables'

/** One thing waiting on the person, in focus mode. */
export interface FocusItem {
  /** Unique across kinds, for skipping. */
  key: string
  kind: 'gap' | 'question' | 'guess'
  id: string
}

/** One step of the kickoff, as the track shows it. */
export interface KickoffStepView {
  key: 'map' | 'check' | 'answer' | 'brief' | 'build'
  name: string
  /** The date the person signed it off, or empty. */
  done: string
  /** Where things stand, from the files. */
  status: string
  /** What to do next for this step. */
  next: string
  /** Something changed after it was signed off, or the files suggest it is not finished. */
  stale: boolean
}

export type DraftField = 'title' | 'topic' | 'page' | 'type' | 'altitude' | 'status' | 'body'
const FIELDS: DraftField[] = ['title', 'topic', 'page', 'type', 'altitude', 'status', 'body']

interface Draft {
  title: string
  topic: string
  page: string
  type: NodeType
  altitude: number
  status: Status
  body: string
}

const timers = new Map<DraftField, ReturnType<typeof setTimeout>>()
/** Fields typed in but not yet confirmed by the server. Live updates skip these. */
const pending = new Set<DraftField>()
/** Deletes started here, so their live event is not reported as a deletion on disk. */
const deleting = new Set<string>()
export const ALL = '*'
/** Replies typed on a card but not sent yet, per card. */
const replyDrafts = new Map<string, string>()
/** Nodes with edits that failed to save, retried after a reconnect. */
const unsaved = new Set<string>()
const freshTimers = new Map<string, ReturnType<typeof setTimeout>>()
let deleteTimer: ReturnType<typeof setTimeout> | undefined
let noteTimer: ReturnType<typeof setTimeout> | undefined

export const state = Alpine.reactive({
  live: false,
  project: {} as Record<string, unknown>,
  nodes: {} as Record<string, GNode>,
  selectedId: null as string | null,
  mode: 'normal' as 'normal' | 'link',
  deleteArmed: false,
  capture: '',
  captureLinked: true,
  editing: null as DraftField | null,
  draft: { title: '', topic: '', page: '', type: 'idea', altitude: 3, status: 'open', body: '' } as Draft,
  /** The page in view, or ALL for the board with everything. */
  currentPage: readStored<string>('groundwork.page', ALL),
  addingPage: false,
  /** The list shows only topics that are thin or have missing pieces. */
  onlyAttention: false,
  reply: '',
  sending: false,
  readiness: null as Readiness | null,
  /** Which view the rail shows: focus, the map, readiness, or deliverables. */
  view: readStored<View>('groundwork.view', 'map'),
  /** How the map draws its cards: as a board, or as an outline. */
  mapLayout: readStored<MapLayout>('groundwork.mapLayout', 'board') === 'outline' ? ('outline' as MapLayout) : ('board' as MapLayout),
  mapLayouts: MAP_LAYOUTS,
  /** The card being dragged on the board, and the cell it is over. */
  dragId: null as string | null,
  dropCell: '',
  /** The kickoff step open on the track, or null for the current one. */
  kickoffOpen: null as string | null,
  /** Items skipped in focus mode this visit. They wait at the end of the queue. */
  focusSkipped: [] as string[],
  stories: [] as Story[],
  /** The product's screens, written by /sitemap. */
  screens: [] as Screen[],
  /** The screen open in the Sitemap view. */
  screenId: readStored<string | null>('groundwork.screen', null),
  screenReply: '',
  screenStatus: '',
  /** The sitemap drawn as boxes and lines, or as a list. */
  sitemapLayout: readStored<'drawn' | 'list'>('groundwork.sitemapLayout', 'drawn'),
  sitemapZoom: readStored('groundwork.sitemapZoom', 1),
  box: BOX,
  brief: null as string | null,
  starter: null as string | null,
  deliverablesTab: readStored<'survey' | 'brief' | 'stories' | 'starter'>('groundwork.deliverablesTab', 'brief'),
  /** The state of the project, written by /survey. */
  survey: null as string | null,
  openStoryId: null as string | null,
  /** A story opened in the right panel from the map. */
  selectedStoryId: null as string | null,
  copied: false,
  /** The right panel shows the readiness report instead of a card. */
  reportOpen: false,
  selectedGapId: null as string | null,
  gapAnswer: '',
  /** Shown under the reply box: what happened to the last reply. */
  replyStatus: '',
  newPage: '',
  listOpen: readStored('groundwork.listOpen', true),
  detailsMinimized: readStored('groundwork.detailsMinimized', false),
  collapsed: readStored<Record<string, boolean>>('groundwork.collapsed', {}),
  editingTitle: false,
  /** Select the whole title when it opens for editing, so typing replaces it. */
  selectTitle: false,
  /** Nodes just added, or just found as duplicates. They light up for a few seconds. */
  freshIds: [] as string[],
  query: '',
  searchOpen: false,
  listIndex: 0,
  note: '',
  types: NODE_TYPES,
  /** Topic and area names as shown: "Flows", not "flows". */
  label: displayName,
  altitudeWords: ALTITUDE_WORDS,
  typeColors: TYPE_COLORS,
  statuses: STATUSES,

  get count() {
    return Object.keys(this.nodes).length
  },
  /** Pages in the person's order, plus any that nodes use. */
  get pageNames(): string[] {
    const saved = Array.isArray(this.project.pages) ? (this.project.pages as string[]) : []
    return mergePages(saved, Object.values(this.nodes).map((n) => n.page))
  },
  get onAll(): boolean {
    return this.currentPage === ALL || !this.pageNames.some((p) => samePage(p, this.currentPage))
  },
  /** The nodes on the page in view. Everything on All. */
  get visibleNodes(): GNode[] {
    const all = Object.values(this.nodes)
    if (this.onAll) return all
    return all.filter((n) => samePage(pageOf(n, this.pageNames), this.currentPage))
  },
  /** The open card's free notes, without its thread. */
  get notesText(): string {
    return splitBody(this.draft.body).notes
  },
  /** Images linked from the notes, as URLs the browser can load. */
  get images(): string[] {
    const out: string[] = []
    for (const m of this.notesText.matchAll(/!\[[^\]]*\]\(\.\.\/files\/([A-Za-z0-9_-]+)\/([^)\s]+)\)/g)) out.push(`/files/${m[1]}/${m[2]}`)
    return out
  },
  get thread(): Entry[] {
    return splitBody(this.draft.body).entries
  },
  /** Cards where Claude is waiting for an answer, in list order. */
  get questionIds(): string[] {
    return groupForList(Object.values(this.nodes), '')
      .flatMap((g) => g.nodes)
      .filter((n) => openQuestions(n.body) > 0)
      .map((n) => n.id)
  },
  /** A thread entry split into its question and the options Claude gave. */
  options: questionOptions,
  hasQuestion(id: string): boolean {
    const n = this.nodes[id]
    return !!n && openQuestions(n.body) > 0
  },
  pageCount(page: string): number {
    return Object.values(this.nodes).filter((n) => samePage(pageOf(n, this.pageNames), page)).length
  },
  get selected(): GNode | null {
    return this.selectedId ? (this.nodes[this.selectedId] ?? null) : null
  },
  /** Existing topic names, for suggestions in the panel. */
  get topicNames(): string[] {
    return [...topicColumns(this.visibleNodes).values()].filter((c) => c.key).map((c) => c.name)
  },
  get listGroups(): ListGroup[] {
    const groups = groupForList(this.visibleNodes, this.query)
    if (!this.onlyAttention) return groups
    return groups.filter((g) => this.needsAttention(g))
  },
  /** A topic is thin with two thoughts or fewer; it needs attention when thin or when gaps sit in it. */
  needsAttention(g: ListGroup): boolean {
    return g.key !== '' && (g.total <= 2 || this.missingIn(g.key) > 0)
  },
  get attentionCount(): number {
    return groupForList(this.visibleNodes, '').filter((g) => this.needsAttention(g)).length
  },
  get listRows(): GNode[] {
    return flatten(this.listGroups.filter((g) => !this.isCollapsed(g.key)))
  },
  /** Width of whatever is docked on the right: the focus card, the details, or nothing. */
  get rightInset(): number {
    if (this.view === 'focus') return 400
    return this.detailsVisible ? 360 : 0
  },
  get detailsVisible(): boolean {
    return (!!this.selected || !!this.selectedGap || !!this.selectedStory || this.reportOpen) && !this.detailsMinimized
  },
  get selectedStory(): Story | null {
    return this.stories.find((st) => st.id === this.selectedStoryId) ?? null
  },
  /** Stories whose first source thought is on the page in view. */
  get visibleStories(): Story[] {
    if (this.onAll) return this.stories
    return this.stories.filter((st) => {
      const first = this.nodes[st.from[0]]
      return first && samePage(pageOf(first, this.pageNames), this.currentPage)
    })
  },
  selectStory(id: string) {
    this.select(null)
    this.selectedStoryId = id
    this.setDetailsMinimized(false)
  },
  get selectedGap(): Gap | null {
    return this.readiness?.gaps.find((g) => g.id === this.selectedGapId) ?? null
  },
  /** Gaps on the page in view. Everything on All. */
  get visibleGaps(): Gap[] {
    const gaps = this.readiness?.gaps ?? []
    if (this.onAll) return gaps
    return gaps.filter((g) => samePage(g.page || this.pageNames[0], this.currentPage))
  },
  /** Open gaps per topic, for the counts in the list. */
  missingIn(topicKey: string): number {
    return this.visibleGaps.filter((g) => !g.answered_by && (g.topic ?? '').trim().toLowerCase() === topicKey).length
  },
  /** The report as HTML. It is a local file written by /readiness, shown as is. */
  get reportHtml(): string {
    const body = this.readiness?.report?.body ?? ''
    return marked.parse(body, { async: false }) as string
  },
  get briefHtml(): string {
    return linkIds(marked.parse(stripFrontmatter(this.brief ?? ''), { async: false }) as string)
  },
  get briefWritten(): string {
    return /^---[\s\S]*?\bwritten:\s*(\S+)[\s\S]*?---/.exec(this.brief ?? '')?.[1] ?? ''
  },
  get starterHtml(): string {
    return marked.parse(stripFrontmatter(this.starter ?? ''), { async: false }) as string
  },
  storyHtml(story: Story): string {
    return marked.parse(story.body, { async: false }) as string
  },
  async loadDeliverables() {
    try {
      const [stories, brief, starter, survey] = await Promise.all([fetchStories(), fetchOutput('brief.md'), fetchOutput('CLAUDE.starter.md'), fetchOutput('survey.md')])
      this.stories = stories
      this.brief = brief
      this.starter = starter
      this.survey = survey
    } catch {
      // Offline: the next reconnect loads them.
    }
  },
  // The site map: every screen, what it is for, who it is for, and what they do there.
  async loadScreens() {
    try {
      this.screens = await fetchScreens()
    } catch {
      // Offline: the next reconnect loads them.
    }
  },
  get screenRows(): { screen: Screen; depth: number }[] {
    return screenTree(this.screens)
  },
  /** The open screen, or the first one. */
  get screen(): Screen | null {
    return this.screens.find((s) => s.id === this.screenId) ?? this.screenRows[0]?.screen ?? null
  },
  screenById(id: string): Screen | undefined {
    return this.screens.find((s) => s.id === id)
  },
  storiesOf(screen: Screen): Story[] {
    return storiesForScreen(screen, this.stories)
  },
  commentsOf(screen: Screen): GNode[] {
    return commentsForScreen(screen, Object.values(this.nodes))
  },
  questionsOn(screen: Screen): number {
    return openQuestions(screen.body)
  },
  /** Screens that link here, and the parent, so the way in is visible too. */
  cameFrom(screen: Screen): Screen[] {
    return this.screens.filter((s) => s.id !== screen.id && (s.leads_to.includes(screen.id) || s.id === screen.parent))
  },
  get screenThread(): Entry[] {
    return this.screen ? splitBody(this.screen.body).entries : []
  },
  get screenNotesHtml(): string {
    const notes = this.screen ? splitBody(this.screen.body).notes.trim() : ''
    return notes ? linkIds(marked.parse(notes, { async: false }) as string) : ''
  },
  get sitemapSummary(): { screens: number; noStory: number; questions: number; guesses: number } {
    return {
      screens: this.screens.length,
      noStory: this.screens.filter((s) => s.status !== 'planned' && !this.storiesOf(s).length).length,
      questions: this.screens.reduce((n, s) => n + openQuestions(s.body), 0),
      guesses: this.screens.filter((s) => s.source === 'inferred').length,
    }
  },
  /** The sitemap as boxes, tree lines, and the links out of the open screen. */
  get sitemapDrawing() {
    const layout = layoutSitemap(this.screens)
    const pad = 24
    const at = new Map(layout.boxes.map((b) => [b.id, { x: b.x + pad, y: b.y + pad }]))
    const { width: w, height: h } = BOX
    const tree = layout.edges.map((e) => {
      const a = at.get(e.from)!
      const b = at.get(e.to)!
      const mid = a.y + h + BOX.gapY / 2
      return `M${a.x + w / 2},${a.y + h} V${mid} H${b.x + w / 2} V${b.y}`
    })
    const open: Screen | null = this.screen
    const links = (open?.leads_to ?? []).filter((id: string) => at.has(id)).map((id: string) => {
      const a = at.get(open!.id)!
      const b = at.get(id)!
      // Above or below: out of the bottom or top, into the facing edge.
      if (Math.abs(b.x - a.x) < w) {
        const down = b.y > a.y
        const sx = a.x + w / 2
        const ex = b.x + w / 2
        const sy = a.y + (down ? h : 0)
        const ey = b.y + (down ? 0 : h)
        const bend = Math.max(30, Math.abs(ey - sy) / 2) * (down ? 1 : -1)
        // Off to the side a little, so it does not hide under the tree line.
        return { id, d: `M${sx + 24},${sy} C${sx + 24},${sy + bend} ${ex + 24},${ey - bend} ${ex + 24},${ey}` }
      }
      // Out of the side facing the target, into the side facing back.
      const right = b.x >= a.x
      const sx = a.x + (right ? w : 0)
      const ex = b.x + (right ? 0 : w)
      const sy = a.y + h / 2
      const ey = b.y + h / 2
      const bend = Math.max(40, Math.abs(ex - sx) / 2)
      return { id, d: `M${sx},${sy} C${sx + (right ? bend : -bend)},${sy} ${ex + (right ? -bend : bend)},${ey} ${ex},${ey}` }
    })
    // Lines as SVG markup: Alpine's template loops cannot live inside an svg element.
    const svg = [
      '<defs><marker id="sitemap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0d99ff" /></marker></defs>',
      ...tree.map((d) => `<path d="${d}" fill="none" stroke="#4a4a4a" stroke-width="1.5" />`),
      ...links.map((l) => `<path d="${l.d}" fill="none" stroke="#0d99ff" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#sitemap-arrow)" />`),
    ].join('')
    return {
      boxes: layout.boxes.map((b) => ({ ...b, x: b.x + pad, y: b.y + pad, screen: this.screenById(b.id) ?? null })),
      svg,
      width: layout.width + pad * 2,
      height: layout.height + pad * 2,
    }
  },
  setSitemapLayout(layout: 'drawn' | 'list') {
    this.sitemapLayout = layout
    store('groundwork.sitemapLayout', layout)
  },
  zoomSitemap(by: number | 'fit') {
    if (by === 'fit') {
      const pane = document.getElementById('sitemap-drawn')
      const d = this.sitemapDrawing
      by = pane ? Math.min(1, (pane.clientWidth - 16) / d.width, (pane.clientHeight - 16) / d.height) : 1
    } else by = this.sitemapZoom * by
    this.sitemapZoom = Math.round(Math.min(1.5, Math.max(0.3, by)) * 100) / 100
    store('groundwork.sitemapZoom', this.sitemapZoom)
  },
  selectScreen(id: string) {
    this.screenId = id
    this.screenReply = ''
    this.screenStatus = ''
    store('groundwork.screen', id)
  },
  /** Save what the person changed: purpose, who it is for, or what they do there. */
  async saveScreen(field: 'purpose' | 'audience' | 'tasks', value: string) {
    const s = this.screen
    if (!s) return
    const input =
      field === 'purpose' ? { purpose: value.trim() }
      : field === 'audience' ? { audience: value.split(',').map((x) => x.trim()).filter(Boolean) }
      : { tasks: value.split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean) }
    const before = field === 'purpose' ? s.purpose : field === 'audience' ? s.audience.join(', ') : s.tasks.join('\n')
    const after = field === 'purpose' ? input.purpose : field === 'audience' ? input.audience!.join(', ') : input.tasks!.join('\n')
    if (before === after) return
    try {
      this.putScreen(await updateScreen(s.id, input))
      this.flash('Saved')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async sendScreenReply() {
    const s = this.screen
    const text = this.screenReply.trim()
    if (!s || !text || this.sending) return
    this.sending = true
    this.screenStatus = 'Saving...'
    try {
      this.putScreen(await updateScreen(s.id, { body: appendEntry(s.body, 'you', text, today()) }))
      this.screenReply = ''
      this.screenStatus = ''
    } catch (err) {
      this.screenStatus = `Not saved: ${errorText(err)}`
    } finally {
      this.sending = false
    }
  },
  putScreen(screen: Screen) {
    const i = this.screens.findIndex((s) => s.id === screen.id)
    if (i >= 0) this.screens[i] = screen
    else this.screens.push(screen)
  },
  /** Open a story under Deliverables. */
  openStory(id: string) {
    this.setDeliverablesTab('stories')
    this.openStoryId = id
    this.setView('deliverables')
  },
  get surveyHtml(): string {
    return linkIds(marked.parse(stripFrontmatter(this.survey ?? ''), { async: false }) as string)
  },
  /** How many findings the survey lists under "What I found". */
  get surveyFindings(): number {
    const m = /^#{1,3}\s+What I found\s*\n([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/im.exec(this.survey ?? '')
    return m ? m[1].split('\n').filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l)).length : 0
  },
  get deliverableTabs(): [string, string][] {
    const tabs: [string, string][] = [['brief', 'Brief'], ['stories', 'Stories'], ['starter', 'CLAUDE.md to start with']]
    return this.survey ? [['survey', 'State of the project'], ...tabs] : tabs
  },
  /** A node id clicked inside a rendered document opens that thought. */
  openIdLink(e: MouseEvent) {
    const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset.node
    if (!id) return
    e.preventDefault()
    if (this.nodes[id]) this.goToNode(id)
    else this.flash(`${id} is not in the map`)
  },
  setDeliverablesTab(tab: 'survey' | 'brief' | 'stories' | 'starter') {
    this.deliverablesTab = tab
    store('groundwork.deliverablesTab', tab)
  },
  async copyStarter() {
    if (!this.starter) return
    try {
      await navigator.clipboard.writeText(this.starter)
      this.copied = true
      setTimeout(() => (this.copied = false), 2000)
    } catch {
      this.flash('The browser did not allow copying. Open .groundwork/outputs/CLAUDE.starter.md instead.')
    }
  },
  /** The gap a thought answers, if it was written as an answer. The gap may be closed by now. */
  answeredGap(node: GNode | null): { id: string; title: string; open: boolean } | null {
    const id = node?.extra?.answers
    if (typeof id !== 'string') return null
    const gap = this.readiness?.gaps.find((g) => g.id === id)
    if (gap) return { id, title: gap.title, open: true }
    const fromNotes = /^Answer to the gap "([^"]+)"/m.exec(node?.body ?? '')?.[1]
    return { id, title: fromNotes ?? id, open: false }
  },
  /** Where a thought came from, in words, when /survey wrote it. */
  sourceLabel(node: GNode | null): string {
    const source = node?.extra?.source
    if (source === 'code') return 'Seen in code'
    if (source === 'docs') return 'From the docs'
    if (source === 'commit') return 'From a commit'
    if (source === 'inferred') return "Claude's guess. Check the thread."
    if (source === 'app') return 'Commented in the running product'
    return ''
  },
  seenIn(node: GNode | null): string[] {
    const v = node?.extra?.seen_in
    return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []
  },
  /** Guesses from /survey that nobody has confirmed yet. */
  get guessCount(): number {
    return Object.values(this.nodes).filter((n) => n.extra?.source === 'inferred' && n.status !== 'settled').length
  },
  async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      this.flash(text.length > 60 ? 'Copied' : `Copied ${text}`)
    } catch {
      this.flash(text)
    }
  },
  /** What the status words mean, shown when hovering them. */
  meaning: {
    missing: 'Missing: nothing in the map covers this yet.',
    thin: 'Thin: something is there, but not enough for a build to rely on. The text beside it says what is lacking.',
    enough: 'Enough: the map covers this well enough to build on, for this kind of project.',
    found: 'Found: in place in the project.',
    partly: 'Partly: started, but not used consistently or not complete. The note says what is lacking.',
    blocking: 'Blocking: stops a real build until it is decided.',
    important: 'Important: building without it will cost rework later.',
    nice: 'Nice: worth having, but nothing breaks without it.',
  } as Record<string, string>,
  /** Hover text for a topic's count in the list. */
  topicCountHint(total: number, missing: number): string {
    const parts = [`${total} ${total === 1 ? 'thought' : 'thoughts'} in this topic.`]
    if (total <= 2) parts.push('Thin: topics with two thoughts or fewer are marked thin. Add more, or merge it into another topic.')
    if (missing) parts.push(`${missing} missing: gaps from /readiness that sit in this topic.`)
    return parts.join(' ')
  },
  /**
   * The design scorecard, one group per platform when a repo holds more than
   * one app ("All" holds the checks across them), or a single group.
   * "5 of 9 in place": found counts as one, partly as half.
   */
  get designGroups(): { platform: string; checks: DesignCheck[]; score: string; percent: number }[] {
    const all = this.readiness?.design ?? []
    const names = [...new Set(all.map((c) => c.platform ?? ''))]
    return names.map((platform) => {
      const checks = all.filter((c) => (c.platform ?? '') === platform)
      const found = checks.filter((c) => c.status === 'found').length
      const partly = checks.filter((c) => c.status === 'partly').length
      const points = found + partly / 2
      return {
        platform: platform.toLowerCase() === 'all' ? 'Across platforms' : platform,
        checks,
        score: checks.length === 1 ? checks[0].status : `${found} of ${checks.length} in place` + (partly ? `, ${partly} partly` : ''),
        percent: checks.length ? Math.round((points / checks.length) * 100) : 0,
      }
    })
  },
  get areas(): Area[] {
    return parseAreas(this.readiness?.report?.body ?? '')
  },
  get openGaps(): Gap[] {
    const order = { blocking: 0, important: 1, nice: 2 }
    return (this.readiness?.gaps ?? []).filter((g) => !g.answered_by).sort((a, b) => order[a.severity] - order[b.severity])
  },
  get waitingGaps(): Gap[] {
    return (this.readiness?.gaps ?? []).filter((g) => g.answered_by && !g.enough)
  },
  /** Gaps the person accepted as they are. Closed for good. */
  get acceptedGaps(): Gap[] {
    return (this.readiness?.gaps ?? []).filter((g) => g.enough)
  },

  // The kickoff: five steps, each signed off by the person. Files only inform.
  /** True when /survey started this map from an existing project. */
  get existingProject(): boolean {
    return Object.values(this.nodes).some((n) => typeof n.extra?.source === 'string')
  },
  /** The last time any thought changed, as a date. */
  get mapChanged(): string {
    return Object.values(this.nodes).reduce((m, n) => (n.modified && n.modified > m ? n.modified : m), '').slice(0, 10)
  },
  get kickoffSteps(): KickoffStepView[] {
    const signed = (this.project.kickoff ?? {}) as Record<string, string>
    const nodes = Object.values(this.nodes)
    const report = this.readiness?.report
    const fromCode = nodes.filter((n) => ['code', 'docs', 'commit'].includes(String(n.extra?.source))).length
    const settled = nodes.filter((n) => n.status === 'settled').length
    const waiting = this.focusQueue.length
    const brief = this.briefWritten
    const reportStale = !!report && !!this.mapChanged && this.mapChanged > report.checked
    const briefStale = !!brief && !!report && report.checked > brief
    return [
      {
        key: 'map',
        name: 'Map',
        done: signed.map ?? '',
        status: nodes.length
          ? `${nodes.length} ${nodes.length === 1 ? 'thought' : 'thoughts'}, ${settled} settled` + (fromCode ? `, ${fromCode} found in the project` : '')
          : 'Nothing in the map yet.',
        next: this.survey
          ? `/survey found ${this.surveyFindings || 'some'} things worth knowing. Read them under Deliverables, State of the project.`
          : this.existingProject || nodes.length ? 'Add what is on your mind. Move on when the purpose and the main flows are in.' : 'Capture what you know, or run /survey in Claude Code if the project already exists.',
        stale: !nodes.length,
      },
      {
        key: 'check',
        name: 'Check',
        done: signed.check ?? '',
        status: report ? `${this.verdictLabel}, checked ${report.checked}` + (reportStale ? '. The map changed since.' : '') : 'Not checked yet.',
        next: 'Run /readiness in Claude Code. It says what is missing and suggests answers.',
        stale: !report || reportStale,
      },
      {
        key: 'answer',
        name: 'Answer',
        done: signed.answer ?? '',
        status: waiting ? `${waiting} waiting on you` + (this.blockingCount ? `, ${this.blockingCount} blocking` : '') : 'Nothing waiting on you.',
        next: waiting ? 'Go through them in Focus. "Enough for now" is a fine answer.' : this.waitingGaps.length ? 'Run /readiness to check your answers.' : 'Move on, or run /challenge for a few sharp questions.',
        stale: waiting > 0,
      },
      {
        key: 'brief',
        name: 'Brief',
        done: signed.brief ?? '',
        status: brief ? `Written ${brief}, ${this.stories.length} ${this.stories.length === 1 ? 'story' : 'stories'}` + (briefStale ? '. Checked again since.' : '') : 'Not written yet.',
        next: 'Run /brief in Claude Code, then read it under Deliverables.',
        stale: !brief || briefStale,
      },
      {
        key: 'build',
        name: 'Build',
        done: signed.build ?? '',
        status: signed.build ? `Kickoff done on ${signed.build}.` : 'Hand the brief to the product.',
        next: this.existingProject
          ? 'Copy the "Working with stories" rules into the CLAUDE.md the project already has, then build against the stories.'
          : 'Copy CLAUDE.starter.md into the product as its CLAUDE.md, then build against the stories.',
        stale: false,
      },
    ]
  },
  /** The first step not signed off, or null when the kickoff is done. */
  get kickoffCurrent(): KickoffStepView | null {
    return this.kickoffSteps.find((s) => !s.done) ?? null
  },
  /** The step shown below the track: the one clicked, or the current one. */
  get kickoffShown(): KickoffStepView | null {
    return this.kickoffSteps.find((s) => s.key === this.kickoffOpen) ?? this.kickoffCurrent
  },
  get kickoffLabel(): string {
    const steps = this.kickoffSteps
    const at = steps.findIndex((s) => !s.done)
    if (at < 0) return 'Kickoff done'
    return `Step ${at + 1} of ${steps.length} · ${steps[at].name}`
  },
  async signOff(key: string) {
    try {
      this.project = await saveKickoff({ [key]: today() })
      this.kickoffOpen = null
      const next = this.kickoffCurrent
      this.flash(next ? `Done. Next: ${next.name}.` : 'Kickoff done. Time to build.')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async reopenStep(key: string) {
    try {
      this.project = await saveKickoff({ [key]: null })
      this.kickoffOpen = null
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** The text to paste into the product's CLAUDE.md: all of it, or only the story rules for an existing project. */
  get handoffText(): string {
    const starter = stripFrontmatter(this.starter ?? '')
    if (!this.existingProject) return starter
    const m = /^#{1,3}\s+Working with stories[\s\S]*?(?=^#{1,2}\s|(?![\s\S]))/im.exec(starter)
    return (m?.[0] ?? starter).trim() + '\n'
  },

  // Focus mode: one thing at a time, only what needs the person.
  /**
   * Everything waiting on the person, most important first: blocking gaps,
   * questions from Claude, guesses from /survey to confirm, then the other
   * gaps. Skipped items wait at the end, in the order they were skipped.
   */
  get focusQueue(): FocusItem[] {
    const gaps = this.openGaps
    const nodes = groupForList(Object.values(this.nodes), '').flatMap((g) => g.nodes)
    const guess = (n: GNode) => n.extra?.source === 'inferred' && n.status === 'open' && !splitBody(n.body).entries.some((e) => e.who === 'you')
    const items: FocusItem[] = [
      ...gaps.filter((g) => g.severity === 'blocking').map((g) => ({ key: `gap:${g.id}`, kind: 'gap' as const, id: g.id })),
      ...nodes.filter((n) => !guess(n) && openQuestions(n.body) > 0).map((n) => ({ key: `node:${n.id}`, kind: 'question' as const, id: n.id })),
      ...nodes.filter(guess).map((n) => ({ key: `node:${n.id}`, kind: 'guess' as const, id: n.id })),
      ...gaps.filter((g) => g.severity !== 'blocking').map((g) => ({ key: `gap:${g.id}`, kind: 'gap' as const, id: g.id })),
    ]
    const skipped = this.focusSkipped
    const rank = (i: FocusItem) => (skipped.includes(i.key) ? 1 + skipped.indexOf(i.key) : 0)
    return items.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i).map((x) => x.item)
  },
  get focusCurrent(): FocusItem | null {
    return this.focusQueue[0] ?? null
  },
  /** True when everything left has been skipped once. */
  get focusOnlySkipped(): boolean {
    const cur = this.focusCurrent
    return !!cur && this.focusSkipped.includes(cur.key)
  },
  get focusGap(): Gap | null {
    const cur = this.focusCurrent
    return cur?.kind === 'gap' ? (this.readiness?.gaps.find((g) => g.id === cur.id) ?? null) : null
  },
  get focusNode(): GNode | null {
    const cur = this.focusCurrent
    return cur && cur.kind !== 'gap' ? (this.nodes[cur.id] ?? null) : null
  },
  /** The open question on the current card, and the options Claude gave with it. */
  get focusQuestion(): { question: string; options: string[] } | null {
    const n = this.focusNode
    const open = n ? splitBody(n.body).entries.find((e) => e.open) : undefined
    return open ? questionOptions(open.text) : null
  },
  /** What the current item offers to start from: suggestions on a gap, options on a question. */
  get focusOptions(): string[] {
    if (this.focusGap) return (this.focusGap.suggestions ?? []).map((s) => s.title)
    return this.focusQuestion?.options ?? []
  },
  /** The ids that stay bright in the map: the current item and what it touches. */
  get focusIds(): string[] {
    const gap = this.focusGap
    if (gap) return [`gap:${gap.id}`, ...gap.near]
    const n = this.focusNode
    return n ? [n.id, ...n.links] : []
  },
  /** The free notes on the current card, without its thread. */
  get focusNotes(): string {
    const n = this.focusNode
    return n ? splitBody(n.body).notes.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() : ''
  },
  /** What to do once nothing needs the person. */
  get focusNextStep(): string {
    if (!this.readiness?.report) return 'Run /readiness in Claude Code to see what is missing.'
    if (this.waitingGaps.length) return `Run /readiness in Claude Code to check your ${this.waitingGaps.length === 1 ? 'answer' : 'answers'}.`
    if (!this.brief) return 'Run /brief in Claude Code to write the brief and the first stories.'
    return 'Run /challenge for a few sharp questions, or keep adding thoughts in the map.'
  },
  enterFocus() {
    this.focusSkipped = []
    this.setView('focus')
    this.focusShow()
  },
  /** Point the map and the selection at the current item, so it scrolls into view. */
  focusShow() {
    const cur = this.focusCurrent
    if (!cur) {
      this.select(null)
      return
    }
    if (cur.kind === 'gap') {
      const gap = this.focusGap
      if (gap?.page && !this.onAll && !samePage(gap.page, this.currentPage)) this.currentPage = gap.page
      if (this.selectedGapId !== cur.id) this.selectGap(cur.id)
    } else {
      const node = this.nodes[cur.id]
      if (node && !this.onAll && !samePage(pageOf(node, this.pageNames), this.currentPage)) this.currentPage = pageOf(node, this.pageNames)
      if (this.selectedId !== cur.id) this.select(cur.id)
    }
    focusWhenVisible('focus-answer')
  },
  focusSkip() {
    const cur = this.focusCurrent
    if (!cur) return
    this.focusSkipped = [...this.focusSkipped.filter((k) => k !== cur.key), cur.key]
    this.focusShow()
  },
  /** Start the skipped ones over, from the top. */
  focusRestart() {
    this.focusSkipped = []
    this.focusShow()
  },
  /** Start an answer from a suggestion or an option. It can be edited before sending. */
  pickOption(text: string) {
    if (this.focusGap || (this.view !== 'focus' && this.selectedGap)) this.gapAnswer = text
    else this.reply = text
    focusWhenVisible(this.view === 'focus' ? 'focus-answer' : 'gap-answer')
  },
  /** A guess from /survey is right: settle it, and answer its question if one is open. */
  async confirmGuess() {
    const n = this.focusNode
    if (!n) return
    const body = openQuestions(n.body) > 0 ? appendEntry(n.body, 'you', 'Yes, that is right.', today()) : n.body
    try {
      this.upsert(await updateNode(n.id, { status: 'settled', body }))
      this.flash('Confirmed and settled.')
      this.focusShow()
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /**
   * "Enough for now": the person accepts the gap as it is. It becomes a
   * settled decision, so /readiness never raises it again, and it closes now
   * instead of waiting for a check.
   */
  async acceptGap() {
    const gap = this.selectedGap
    if (!gap) return
    const why = this.gapAnswer.trim()
    try {
      const node = await createNode({
        type: 'decision',
        status: 'settled',
        title: `Enough for now: ${gap.title}`,
        topic: gap.topic ?? '',
        page: gap.page ?? '',
        altitude: gap.altitude ?? 3,
        links: gap.near.filter((id) => this.nodes[id]),
        body: `${why ? why + '\n\n' : ''}Accepted as it is for now, from the gap "${gap.title}": ${gap.why}\n`,
        answers: gap.id,
      })
      this.upsert(node)
      this.readiness = await markGapAnswered(gap.id, node.id, true)
      this.gapAnswer = ''
      this.flash('Accepted for now. /readiness will not raise it again.')
      if (this.view === 'focus') this.focusShow()
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  get blockingCount(): number {
    return this.openGaps.filter((g) => g.severity === 'blocking').length
  },
  /** What has been decided: decisions and settled thoughts, by topic. Shown outside the map. */
  get settledGroups(): { topic: string; nodes: GNode[] }[] {
    const settled = Object.values(this.nodes).filter((n) => n.status === 'settled' || (n.type === 'decision' && n.status !== 'parked'))
    const groups = new Map<string, GNode[]>()
    for (const n of settled) {
      const t = n.topic || 'no topic'
      groups.set(t, [...(groups.get(t) ?? []), n])
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a === 'no topic' ? 1 : b === 'no topic' ? -1 : a.localeCompare(b)))
      .map(([topic, nodes]) => ({ topic, nodes: nodes.sort((a, b) => b.altitude - a.altitude || a.title.localeCompare(b.title)) }))
  },
  setView(view: View) {
    // Leaving focus for another page closes the card focus had open. The map keeps it, to see it in place.
    if (this.view === 'focus' && view !== 'focus' && view !== 'map') this.closePanel()
    this.view = view
    store('groundwork.view', view)
    if (view === 'map') revealSelection()
  },
  /**
   * A comment pointed out on the phone, to be written here: open it with the
   * title selected, so typing replaces the placeholder.
   */
  writeComment(id: string) {
    if (!this.nodes[id]) return
    this.goToNode(id)
    this.selectTitle = true
    this.editingTitle = true
    window.focus()
  },
  /** Open a thought in the map, from any view. */
  goToNode(id: string) {
    const node = this.nodes[id]
    if (!node) return
    if (!this.onAll && !samePage(pageOf(node, this.pageNames), this.currentPage)) this.showPage(pageOf(node, this.pageNames))
    if (this.view !== 'map') this.setView('map')
    this.select(id)
  },
  get verdictLabel(): string {
    const r = this.readiness
    if (!r?.report) return ''
    const blocking = r.gaps.filter((g) => g.severity === 'blocking' && !g.answered_by).length
    const verdict = r.report.verdict ?? 'checked'
    return verdict.charAt(0).toUpperCase() + verdict.slice(1) + (blocking ? ` · ${blocking} blocking` : '')
  },
  /**
   * The space between the side panels, for bars that float over the map.
   * An object, not a string: a string binding would replace the whole style
   * attribute and undo x-show.
   */
  get mapArea(): { left: string; right: string } {
    const wide = window.innerWidth >= 900
    const left = 64 + (this.view === 'map' && this.listOpen && wide ? 320 : 0)
    return { left: `${left}px`, right: `${this.rightInset}px` }
  },
  // The board and the outline: two ways to draw the same cards.
  get board(): Board {
    return buildBoard(this.visibleNodes, this.visibleGaps, this.visibleStories)
  },
  get outline(): OutlineSection[] {
    return buildOutline(this.visibleNodes, this.visibleGaps)
  },
  firstLine,
  setMapLayout(layout: MapLayout) {
    this.mapLayout = layout
    store('groundwork.mapLayout', layout)
    revealSelection()
  },
  /** `V`: the next way to draw the map. */
  cycleLayout() {
    const keys = MAP_LAYOUTS.map((l) => l.key)
    const next = keys[(keys.indexOf(this.mapLayout) + 1) % keys.length]
    this.setMapLayout(next)
    this.flash(MAP_LAYOUTS.find((l) => l.key === next)!.name)
  },
  /** A card clicked in any layout: a thought, a ghost gap (gap:<id>) or a story (story:<id>). */
  clickCard(id: string) {
    // In focus mode, clicking another card leaves focus and opens it in the map.
    if (this.view === 'focus') {
      this.setView('map')
      if (id.startsWith('gap:')) return this.showGapInMap(id.slice(4))
      if (id.startsWith('story:')) return this.selectStory(id.slice(6))
      return this.goToNode(id)
    }
    if (id.startsWith('gap:')) return this.selectGap(id.slice(4))
    if (id.startsWith('story:')) return this.selectStory(id.slice(6))
    if (this.mode === 'link' && this.selectedId && id !== this.selectedId) void this.toggleLink(id)
    else this.select(id)
  },
  clickBackground() {
    if (this.view === 'focus') return
    if (this.mode !== 'link') this.select(null)
  },
  /** Linked to the open card, so it lights up on the board. */
  isLinked(id: string): boolean {
    return !!this.selected?.links.includes(id)
  },
  /** In focus mode everything but the current item and what it touches is dimmed. */
  dimmed(id: string): boolean {
    return this.view === 'focus' && !!this.focusCurrent && !this.focusIds.includes(id)
  },
  /** Dropping a card in another cell gives it that topic and altitude. */
  async moveCard(id: string, column: string, altitude: number) {
    const node = this.nodes[id]
    this.dragId = null
    this.dropCell = ''
    if (!node || node.error) return
    const col = this.board.columns.find((c) => c.key === column)
    const topic = column && col ? col.name : ''
    const changes: NodeInput = {}
    if (topicKey(node.topic) !== column) changes.topic = topic
    if (node.altitude !== altitude) changes.altitude = altitude
    if (!Object.keys(changes).length) return
    try {
      this.upsert(await updateNode(id, changes))
      this.markFresh(id)
      const where = [changes.topic !== undefined && `to ${topic || 'no topic'}`, changes.altitude !== undefined && `to ${ALTITUDE_WORDS[altitude]}`].filter(Boolean).join(', ')
      this.flash(`Moved ${where}`)
    } catch (err) {
      this.flash(errorText(err))
    }
  },

  get linkedNodes(): GNode[] {
    const sel = this.selected
    if (!sel) return []
    return sel.links.map((id) => this.nodes[id]).filter(Boolean)
  },

  // Data from the server. Responses and events both land here, in any order.
  replaceAll(nodes: GNode[]) {
    this.nodes = Object.fromEntries(nodes.map((n) => [n.id, n]))
    if (this.selectedId && !this.nodes[this.selectedId]) this.select(null)
    else if (this.selected) this.syncDraft()
  },
  upsert(node: GNode) {
    this.nodes[node.id] = node
    if (node.id === this.selectedId) this.syncDraft()
  },
  removeLocal(id: string) {
    if (!this.nodes[id]) return
    delete this.nodes[id]
    if (id === this.selectedId) {
      this.select(null)
      if (!deleting.has(id)) this.flash('That node was deleted on disk')
    }
  },

  async loadReadiness() {
    try {
      this.readiness = await fetchReadiness()
    } catch {
      // Offline: the next reconnect loads it.
    }
  },
  /** Close whatever the right panel shows. */
  closePanel() {
    this.select(null)
    this.reportOpen = false
  },
  openReport() {
    this.select(null)
    this.reportOpen = true
    this.setDetailsMinimized(false)
  },
  /** Go to a gap in the map: its page, the map view, and its ghost card in view. */
  showGapInMap(id: string) {
    const gap = this.readiness?.gaps.find((g) => g.id === id)
    if (!gap) return
    if (gap.page && !this.onAll && !samePage(gap.page, this.currentPage)) {
      this.currentPage = gap.page
      store('groundwork.page', gap.page)
    }
    this.view = 'map'
    store('groundwork.view', 'map')
    this.selectGap(id)
  },
  selectGap(id: string) {
    this.select(null)
    this.selectedGapId = id
    this.gapAnswer = ''
    this.setDetailsMinimized(false)
    revealSelection()
  },
  /**
   * Write about a gap. Either way the text becomes a thought where the gap
   * sits. Only "this answers it" marks the gap for /readiness to check; a
   * remark leaves it open.
   */
  async answerGap(closes = true) {
    const gap = this.selectedGap
    const title = this.gapAnswer.trim()
    if (!gap || !title) return
    try {
      const links = gap.near.filter((id) => this.nodes[id])
      // The thought keeps its context: which gap it answers and why that gap mattered.
      const body = `Answer to the gap "${gap.title}": ${gap.why}\n`
      const node = await createNode({ title, topic: gap.topic ?? '', page: gap.page ?? '', altitude: gap.altitude ?? 3, links, body, answers: gap.id })
      this.upsert(node)
      this.markFresh(node.id)
      if (closes) this.readiness = await markGapAnswered(gap.id, node.id)
      this.gapAnswer = ''
      this.flash(closes ? 'Marked as answered. /readiness decides if it closes.' : 'Added as a thought. The gap stays open.')
      if (this.view === 'focus') this.focusShow()
    } catch (err) {
      this.flash(errorText(err))
    }
  },

  select(id: string | null) {
    if (id) {
      this.reportOpen = false
    }
    if (this.selectedGapId) {
      this.selectedGapId = null
    }
    if (this.selectedStoryId) {
      this.selectedStoryId = null
    }
    // Each card keeps its own half typed reply, so an answer never lands on the wrong card.
    if (this.selectedId !== id) {
      if (this.selectedId) replyDrafts.set(this.selectedId, this.reply)
      this.reply = (id && replyDrafts.get(id)) || ''
      this.replyStatus = ''
    }
    if (this.selectedId && unsaved.has(this.selectedId) && this.selectedId !== id) {
      this.flash('Some edits on the last card were not saved. Groundwork is offline.')
    }
    this.flushAll()
    this.selectedId = id
    this.deleteArmed = false
    this.captureLinked = true
    this.editingTitle = false
    if (!id) this.mode = 'normal'
    pending.clear()
    this.editing = null
    this.syncDraft()
    if (id) revealSelection()
  },

  /** Copy the node into the panel, except fields the person is busy with. */
  syncDraft() {
    const node = this.selected
    if (!node) return
    for (const f of FIELDS) {
      if (f === this.editing || pending.has(f)) continue
      ;(this.draft as Record<DraftField, unknown>)[f] = f === 'page' ? pageOf(node, this.pageNames) : node[f]
    }
  },

  // Capture bar
  async submitCapture() {
    const parsed = parseCapture(this.capture)
    if (!parsed) return
    const raw = this.capture
    const linkTo = this.selected && !this.selected.error && this.captureLinked ? this.selected : null
    this.capture = ''

    // The same thought twice is almost always a second Enter. Point at the first one instead.
    const same = Object.values(this.nodes).find((n) => sameTitle(n.title, parsed.title))
    if (same) {
      this.markFresh(same.id)
      this.flash(`Already in the map: "${same.title}"`)
      return
    }

    try {
      // A thought linked to the open node joins its topic too.
      // New thoughts land on the page in view, or next to the node they link to.
      const page = linkTo ? linkTo.page : this.onAll ? '' : this.currentPage
      const node = await createNode({ ...parsed, links: linkTo ? [linkTo.id] : [], topic: linkTo?.topic ?? '', page })
      this.upsert(node)
      this.markFresh(node.id)
      this.flash(`Added to ${node.topic || 'no topic'}`)
    } catch (err) {
      // Give the text back so nothing typed is lost.
      if (!this.capture) this.capture = raw
      this.flash(errorText(err))
    }
  },

  // Panel editing
  focusField(f: DraftField) {
    this.editing = f
  },
  blurField(f: DraftField) {
    if (this.editing === f) this.editing = null
    this.flush(f)
  },
  /** Save a field after a short pause in typing, or right away for select fields. */
  edit(f: DraftField, immediate = false) {
    pending.add(f)
    clearTimeout(timers.get(f))
    if (immediate) this.flush(f)
    else timers.set(f, setTimeout(() => this.flush(f), 400))
  },
  async flush(f: DraftField) {
    clearTimeout(timers.get(f))
    timers.delete(f)
    const id = this.selectedId
    if (!id || !pending.has(f)) return
    const value = this.draft[f]
    if (f === 'title' && !String(value).trim()) {
      // A node always needs a title. Keep the old one until something is typed.
      pending.delete(f)
      if (this.editing !== f) this.syncDraft()
      return
    }
    try {
      const node = await updateNode(id, { [f]: value })
      // Only clear the flag if nothing newer was typed while this was in flight.
      if (this.draft[f] === value && !timers.has(f)) pending.delete(f)
      this.upsert(node)
    } catch (err) {
      // Keep what was typed. It is saved again when the connection is back.
      unsaved.add(id)
      this.flash(`Not saved yet: ${errorText(err)}`)
    }
  },
  flushAll() {
    for (const f of [...pending]) void this.flush(f)
  },
  /** After a reconnect: save whatever could not be saved while offline. */
  retryUnsaved() {
    if (this.selectedId && unsaved.has(this.selectedId)) {
      unsaved.clear()
      this.flushAll()
    }
  },

  /** `[` and `]`: move the open node one altitude step. */
  nudgeAltitude(delta: number) {
    const sel = this.selected
    if (!sel || sel.error) return
    const next = Math.min(5, Math.max(1, this.draft.altitude + delta))
    if (next === this.draft.altitude) return
    this.draft.altitude = next
    this.edit('altitude', true)
  },

  markFresh(id: string) {
    if (!this.freshIds.includes(id)) this.freshIds.push(id)
    clearTimeout(freshTimers.get(id))
    freshTimers.set(
      id,
      setTimeout(() => {
        this.freshIds = this.freshIds.filter((f) => f !== id)
      }, 4000),
    )
  },

  setNotes(notes: string) {
    this.draft.body = replaceNotes(this.draft.body, notes)
    this.edit('body')
  },
  /** Paste or drop images into the notes: upload each and put its markdown at the cursor. */
  async attachImages(files: File[], field: HTMLTextAreaElement) {
    const id = this.selectedId
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!id || !images.length) return false
    let at = field.selectionStart ?? this.notesText.length
    for (const file of images) {
      try {
        const { markdown } = await uploadImage(id, file)
        const notes = this.notesText
        const before = notes.slice(0, at)
        const piece = `${before && !before.endsWith('\n') ? '\n' : ''}${markdown}\n`
        this.setNotes(before + piece + notes.slice(at))
        at += piece.length
      } catch (err) {
        this.flash(errorText(err))
      }
    }
    return true
  },
  /** Add a reply to the thread. The text stays in the box until it is saved. */
  async sendReply() {
    const text = this.reply.trim()
    const id = this.selectedId
    if (!text || !id || this.sending) return
    const body = appendEntry(this.draft.body, 'you', text, today())
    this.sending = true
    this.replyStatus = 'Saving...'
    try {
      clearTimeout(timers.get('body'))
      timers.delete('body')
      const node = await updateNode(id, { body })
      pending.delete('body')
      replyDrafts.delete(id)
      if (this.selectedId === id) {
        this.draft.body = body
        this.reply = ''
      }
      this.replyStatus = ''
      this.upsert(node)
      if (this.view === 'focus') this.focusShow()
    } catch (err) {
      this.replyStatus = `Not saved: ${errorText(err)}`
      console.error('Reply not saved', err)
    } finally {
      this.sending = false
    }
  },
  /** Open the next card with a question, moving to its page if needed. */
  nextQuestion() {
    const ids = this.questionIds
    if (!ids.length) return
    const at = this.selectedId ? ids.indexOf(this.selectedId) : -1
    const id = ids[(at + 1) % ids.length]
    const node = this.nodes[id]
    if (!this.onAll && !samePage(pageOf(node, this.pageNames), this.currentPage)) this.showPage(pageOf(node, this.pageNames))
    this.select(id)
  },

  showPage(page: string) {
    this.currentPage = page
    store('groundwork.page', page)
  },
  async addPage() {
    const name = this.newPage.trim()
    this.addingPage = false
    this.newPage = ''
    if (!name) return
    if (!this.pageNames.some((p) => samePage(p, name))) {
      try {
        this.project = await savePages([...this.pageNames, name])
      } catch (err) {
        return this.flash(errorText(err))
      }
    }
    this.showPage(this.pageNames.find((p) => samePage(p, name)) ?? name)
  },

  setDetailsMinimized(min: boolean) {
    this.detailsMinimized = min
    store('groundwork.detailsMinimized', min)
  },

  isCollapsed(key: string): boolean {
    // While searching, every match shows.
    return !this.query && !!this.collapsed[key]
  },
  toggleGroup(key: string) {
    this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] }
    store('groundwork.collapsed', this.collapsed)
  },

  // List and search
  /** `/`: show the list if it is collapsed and put the cursor in search. */
  openList() {
    this.setListOpen(true)
    this.searchOpen = true
    this.listIndex = 0
    focusWhenVisible('search')
  },
  setListOpen(open: boolean) {
    this.listOpen = open
    if (!open) this.query = ''
    store('groundwork.listOpen', open)
  },
  /** Esc in search clears it and gives the keys back to the map. */
  leaveSearch() {
    this.query = ''
    this.listIndex = 0
    this.searchOpen = false
  },
  moveList(delta: number) {
    const count = this.listRows.length
    if (count) this.listIndex = (this.listIndex + delta + count) % count
  },
  chooseRow(id?: string) {
    const row = id ? this.nodes[id] : this.listRows[this.listIndex]
    if (row) this.select(row.id)
  },

  // Links
  toggleLinkMode() {
    if (!this.selected || this.selected.error) return
    this.mode = this.mode === 'link' ? 'normal' : 'link'
  },
  async toggleLink(otherId: string) {
    const sel = this.selected
    if (!sel || sel.error || otherId === sel.id) return
    const links = sel.links.includes(otherId) ? sel.links.filter((l) => l !== otherId) : [...sel.links, otherId]
    try {
      this.upsert(await updateNode(sel.id, { links }))
    } catch (err) {
      this.flash(errorText(err))
    }
  },

  // Deleting takes two presses, so a stray key never loses a thought.
  requestDelete() {
    if (!this.selectedId || this.selected?.error) return
    if (this.deleteArmed) return void this.confirmDelete()
    this.deleteArmed = true
    clearTimeout(deleteTimer)
    deleteTimer = setTimeout(() => (this.deleteArmed = false), 3000)
  },
  async confirmDelete() {
    const id = this.selectedId
    if (!id) return
    clearTimeout(deleteTimer)
    pending.clear()
    deleting.add(id)
    try {
      await deleteNode(id)
      this.removeLocal(id)
    } catch (err) {
      this.flash(errorText(err))
    } finally {
      deleting.delete(id)
    }
  },

  flash(text: string) {
    this.note = text
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (this.note = ''), 4000)
  },
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Node ids in rendered text, like (n_bz8p), become links to the thought. Text only, never inside tags. */
function linkIds(html: string): string {
  return html.replace(/(<[^>]*>)|\b(n_[a-z0-9]{4})\b/g, (m, tag, id) => (tag ? tag : `<a href="#" class="node-link" data-node="${id}">${id}</a>`))
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '')
}

/** Layout choices are remembered per browser. Storage can be blocked, so fall back quietly. */
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The setting still applies for this visit.
  }
}


/**
 * Focus a field as soon as Alpine has shown it, so keys typed right away land
 * in the field. Falls back to waiting a few frames if it is still hidden.
 */
function focusWhenVisible(id: string, tries = 20) {
  Alpine.nextTick(() => {
    const el = document.getElementById(id)
    if (el && el.offsetParent !== null) return el.focus()
    if (tries > 0) requestAnimationFrame(() => focusWhenVisible(id, tries - 1))
  })
}

/** Scroll the open card into view on the board or the outline. */
function revealSelection() {
  Alpine.nextTick(() => {
    const id = state.selectedId ?? (state.selectedGapId ? `gap:${state.selectedGapId}` : null)
    if (!id) return
    for (const el of document.querySelectorAll<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)) {
      if (el.offsetParent !== null) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

Alpine.store('gw', state)
