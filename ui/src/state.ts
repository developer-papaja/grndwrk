import Alpine from 'alpinejs'
import { cached } from './reactivity'
import type { DesignCheck, FocusItem, Foundation, Gap, GNode, NodeInput, NodeType, PairRequest, Persona, PersonaList, Readiness, Screen, Segment, Status, Story } from '../../src/shared/types'
import { NODE_TYPES, PERSONA_CHOICES, PERSONA_DEVICES, PERSONA_EMPLOYERS, PERSONA_TIERS, SEGMENT_HOW, SEGMENT_TYPES, SIZE_BANDS, STATUSES } from '../../src/shared/types'
import { answerPairRequest, answerSiteRequest, fetchSites, removeSite, type AllowedSite, createNode, deleteNode, fetchPairRequests, fetchRuntime, fetchShots, placeShot, type Shot, fetchDraft, fetchOutput, fetchReadiness, setFocusLater, fetchScreens, fetchPersonas, createPersona, updatePersona, deletePersona, settleName, fetchSegments, createSegment, updateSegment as saveSegment, deleteSegment, type PersonaInput, type SegmentInput, fetchStories, fetchDocs, fetchDoc, openDocInEditor, type Doc, createStory, updateStory as saveStory, markGapAnswered, saveKickoff, savePages, saveProjectFields, updateNode, updateScreen, uploadImage, markTested, fetchRelay, inviteColleague, removeFromRelay, type RelayInfo } from './api'
import { BOX, commentsForScreen, hiddenScreenIds, layoutSitemap, needsExample, openPath, screenTree, shotsForScreen, storiesForScreen } from '../../src/shared/screens'
import { buildStatus, type ProjectStatus, type StatusRow } from '../../src/shared/status'
import { mergePages, pageOf, samePage } from '../../src/shared/pages'
import { answerText, appendAnswer, appendEntry, openQuestions, questionOptions, questions, replaceNotes, splitBody, type Entry, type Question } from '../../src/shared/thread'
import { parseAreas, type Area } from '../../src/shared/report'
import qrcode from 'qrcode-generator'
import { FEEDBACK_STATES, feedbackState, isFeedback, isFixed, testSteps, type FeedbackState } from '../../src/shared/feedback'
import { criteriaOf, storyStatusLabel, tickCriterion, type Criterion } from '../../src/shared/story'
import { PROGRESS, PROGRESS_WORDS, progressOfNode, progressOfStory, showsProgress, type Progress, type ProgressFilter } from '../../src/shared/progress'
import { parseCapture, sameTitle } from './capture'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ALTITUDE_WORDS, displayName, topicColumns, topicKey } from './layout'
import { TYPE_COLORS } from './palette'
import { flatten, groupForList, type ListGroup } from './list'
import { buildBoard, buildOutline, CARD_GROUPS, featureOf, firstLine, MAP_LAYOUTS, screenOf, type Board, type CardGroup, type GroupBy, type MapLayout, type OutlineSection } from './board'
import { counterpart, inVariant, narrowView, projectVariants, unknownVariants } from '../../src/shared/variants'
import { inBand, isGuess, looseNames, personaNamed, readEvidence, readSections, screensForPersona, SECTIONS, sizeLabel, themeCounts, type Evidence } from '../../src/shared/personas'

export type View = 'focus' | 'map' | 'sitemap' | 'personas' | 'readiness' | 'docs' | 'deliverables'

/** A question from Claude waiting on the person, in the Inbox. */
export interface InboxItem {
  /** Unique across kinds: node:<id> or screen:<id>. */
  key: string
  /** A question on a thought, a guess from /survey to confirm, or a question on a screen. */
  kind: 'question' | 'guess' | 'screen' | 'persona'
  id: string
  /** The question, without its options and pictures. */
  question: string
  options: string[]
  /** The whole entry, for the pictures it shows. */
  text: string
  /** Which question of the thread it is, so several on one thought are answered one by one. -1 for a guess without a question. */
  entry: number
  index: number
  /** How many questions wait on the same thought, and which of them this is. */
  of: number
  position?: number
  /** What it is about: the thought's or the screen's title. */
  about: string
  /** Where that sits: the topic, or the screen's place in the tree. */
  where: string
  date: string
}

/** A setting in the map's toolbar, shown as a menu. */
export interface MapMenu {
  key: string
  name: string
  /** The current choice, shown on the button. */
  value: string
  title: string
  /** The icon on the button, by symbol id. It stands for the setting; the words are the current choice. */
  icon: string
  /** Only the icon on the button: the choice shows in the icon itself. */
  iconOnly?: boolean
  /** Narrows what the map shows, so the button is marked. */
  active?: boolean
  /** Sits at the right end of the toolbar. */
  right?: boolean
  options: { key: string; label: string; hint?: string; count?: number; on: boolean }[]
}

/** One step of the kickoff, as the track shows it. */
export interface KickoffStepView {
  key: 'purpose' | 'map' | 'check' | 'answer' | 'brief' | 'build'
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

/** The Show filter kept in this browser; a choice from the older Comments menu carries over. */
function readProgressFilter(): ProgressFilter {
  const kept = readStored<string>('grndwrk.progressFilter', '')
  if (kept === '' || kept === 'all' || (PROGRESS as string[]).includes(kept)) return kept as ProgressFilter
  return ''
}

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
  currentPage: readStored<string>('grndwrk.page', ALL),
  addingPage: false,
  /** The list shows only topics that are thin or have missing pieces. */
  onlyAttention: false,
  reply: '',
  sending: false,
  readiness: null as Readiness | null,
  /** Which view the rail shows: focus, the map, readiness, or deliverables. */
  view: readStored<View>('grndwrk.view', 'map'),
  /** How the map draws its cards: as a board, or as an outline. */
  mapLayout: readStored<MapLayout>('grndwrk.mapLayout', 'board') === 'outline' ? ('outline' as MapLayout) : ('board' as MapLayout),
  mapLayouts: MAP_LAYOUTS,
  /** What the board's columns are: the product's screens (General first), or topics. */
  groupBy: readStored<GroupBy>('grndwrk.groupBy', 'page'),
  /** The card being dragged on the board, and the cell it is over. */
  dragId: null as string | null,
  dropCell: '',
  /** The kickoff step open on the track, or null for the current one. */
  kickoffOpen: null as string | null,
  /** Answers being written in the Inbox, per item. */
  inboxDrafts: {} as Record<string, string>,
  /** Inbox questions opened to show their whole thought or screen. */
  inboxOpen: {} as Record<string, boolean>,
  inboxSending: '',
  stories: [] as Story[],
  /** The product's screens, written by /sitemap. */
  screens: [] as Screen[],
  /** The screen open in the Sitemap view. */
  screenId: readStored<string | null>('grndwrk.screen', null),
  screenReply: '',
  screenStatus: '',
  /** The sitemap drawn as boxes and lines, or as a list. */
  sitemapLayout: readStored<'drawn' | 'list'>('grndwrk.sitemapLayout', 'drawn'),
  sitemapZoom: readStored('grndwrk.sitemapZoom', 1),
  box: BOX,
  brief: null as string | null,
  starter: null as string | null,
  deliverablesTab: readStored<'survey' | 'brief' | 'stories' | 'starter'>('grndwrk.deliverablesTab', 'brief'),
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
  listOpen: readStored('grndwrk.listOpen', true),
  detailsMinimized: readStored('grndwrk.detailsMinimized', false),
  collapsed: readStored<Record<string, boolean>>('grndwrk.collapsed', {}),
  /** Light or dark, or whatever the system uses (the default). Kept per browser. */
  theme: readTheme(),
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
    return cached('pageNames', () => {
      const saved = Array.isArray(this.project.pages) ? (this.project.pages as string[]) : []
      return mergePages(saved, Object.values(this.nodes).map((n) => n.page))
    })
  },
  get onAll(): boolean {
    return this.currentPage === ALL || !this.pageNames.some((p) => samePage(p, this.currentPage))
  },
  /** The nodes on the page in view, before the feedback filter. Everything on All. */
  get pageNodes(): GNode[] {
    return cached('pageNodes', () => {
      const all = Object.values(this.nodes)
      // Working on one part shows its thoughts from every page.
      if (this.scopeScreen) return all.filter((n) => this.inScope(n))
      if (this.onAll) return all
      // Once, not per node: pageNames reads every node itself.
      const names = this.pageNames
      return all.filter((n) => samePage(pageOf(n, names), this.currentPage))
    })
  },
  /** The nodes in view: what the Show filter asks for (by default everything not finished), on the screens of the variant in view. */
  get visibleNodes(): GNode[] {
    return cached('visibleNodes', () => {
      const f = this.progressFilter
      const hidden = this.hiddenScreens
      return this.pageNodes.filter((n) => showsProgress(f, progressOfNode(n)) && !(hidden.size && hidden.has(screenOf(n, this.screens))))
    })
  },
  // Variants: the product in several versions at once, like a redesign next to the previous UI.
  /** The variants project.md lists. Empty: no switcher, everything as usual. */
  get variants(): string[] {
    return projectVariants(this.project)
  },
  /** The variant chosen per project, kept in the browser. '*' is All. */
  variantChoice: readStored<Record<string, string>>('grndwrk.variant', {}),
  get variantKey(): string {
    const chosen = this.variantChoice[String(this.project.name ?? '')]
    if (chosen === ALL) return ALL
    return this.variants.find((v) => v === chosen) ?? this.variants[0] ?? ALL
  },
  /** The variant in view, or null for all of them (or none declared). */
  get variant(): string | null {
    return this.variants.length && this.variantKey !== ALL ? this.variantKey : null
  },
  setVariant(key: string) {
    this.variantChoice = { ...this.variantChoice, [String(this.project.name ?? '')]: key }
    store('grndwrk.variant', this.variantChoice)
  },
  /**
   * The screens in view: those of the variant in view, without the ones the
   * person hid (unless hidden ones are shown), with parents and links inside them.
   */
  get viewScreens(): Screen[] {
    return cached('viewScreens', () => {
      const out = this.hiddenScreens
      return out.size ? narrowView(this.screens, new Set(this.screens.filter((s) => !out.has(s.id)).map((s) => s.id))) : this.screens
    })
  },
  /** Screens out of view: not in the variant in view, or hidden. Their thoughts, gaps and stories are out of view too. */
  get hiddenScreens(): Set<string> {
    return cached('hiddenScreens', () => {
      const variant = this.variant
      const out = new Set(variant === null ? [] : this.screens.filter((s) => !inVariant(s, variant)).map((s) => s.id))
      if (!this.showHidden) for (const id of this.hiddenIds) out.add(id)
      return out
    })
  },
  // Hidden screens: playgrounds and leftovers someone hid from the sitemap, for everyone (`hidden:` in the file).
  /** Screens hidden in their files, and the screens under them. Not part of the product: Status and the Inbox leave them out. */
  get hiddenIds(): Set<string> {
    return cached('hiddenIds', () => hiddenScreenIds(this.screens))
  },
  /** Whether hidden screens are shown anyway, marked as hidden. Kept in the browser. */
  showHidden: readStored('grndwrk.showHidden', false),
  setShowHidden(show: boolean) {
    this.showHidden = show
    store('grndwrk.showHidden', show)
  },
  /** Hide a screen (and what sits under it) from the sitemap, or show it again. */
  async setScreenHidden(id: string, hidden: boolean) {
    try {
      this.putScreen(await updateScreen(id, { hidden }))
      this.flash(hidden ? (this.showHidden ? 'Hidden' : 'Hidden. Show hidden screens brings it back.') : 'Shown again')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** "Hidden", or "Hidden with Playground" for a screen under a hidden one. Empty when shown. */
  hiddenTag(screen: Screen | null): string {
    if (!screen || !this.hiddenIds.has(screen.id)) return ''
    if (screen.hidden) return 'Hidden'
    const byId = new Map(this.screens.map((s) => [s.id, s]))
    const seen = new Set<string>()
    let at = byId.get(screen.parent)
    while (at && !at.hidden && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.parent)
    }
    return at ? `Hidden with ${at.title}` : 'Hidden'
  },
  /** "Only in Previous UI" for a screen in some variants only. */
  variantTag(screen: Screen | null): string {
    return screen && this.variants.length && screen.in.length ? `Only in ${screen.in.join(', ')}` : ''
  },
  unknownVariants(screen: Screen | null): string[] {
    return screen && this.variants.length ? unknownVariants(screen, this.variants) : []
  },
  /** The screen that stands for this one in another variant, and which variant that is. */
  counterpartOf(screen: Screen | null): { screen: Screen; variant: string } | null {
    const other = screen ? counterpart(screen, this.screens) : null
    if (!other) return null
    return { screen: other, variant: other.in.join(', ') || 'every variant' }
  },
  /** Open the counterpart, switching to a variant that has it when the one in view does not. */
  goToCounterpart(id: string) {
    const target = this.screens.find((s) => s.id === id)
    if (!target) return
    if (!inVariant(target, this.variant)) this.setVariant(target.in.find((v) => this.variants.includes(v)) ?? ALL)
    this.selectScreen(id)
  },
  // Comments from the running product: incoming, with a proposed fix, or fixed by the person.
  /** Empty shows incoming and proposed with the rest of the map; a state shows only those comments. */
  /** What the map shows, for comments, stories and thoughts alike: everything not finished (''), one status, or all. */
  progressFilter: readProgressFilter(),
  progressWords: PROGRESS_WORDS,
  feedbackStates: FEEDBACK_STATES,
  /** The toolbar menu that is open, by key. */
  openMenu: '',
  /**
   * The map's settings, each a menu in the toolbar that shows its current
   * value: what the columns are, which variant, which comments (on the
   * Feedback page only) and how the map is drawn.
   */
  get mapMenus(): MapMenu[] {
    const menus: MapMenu[] = []
    if (this.screens.length && !this.scopeScreen) {
      menus.push({
        key: 'menu-columns',
        name: 'Columns',
        value: this.groupBy === 'topic' ? 'Topics' : 'Screens',
        title: 'Columns: a screen each, or a topic each',
        icon: this.groupBy === 'topic' ? 'i-tag' : 'i-tree',
        options: [
          { key: 'page', label: 'Screens', hint: 'General first, then each screen in sitemap order', on: this.groupBy === 'page' },
          { key: 'topic', label: 'Topics', hint: 'A column per topic', on: this.groupBy === 'topic' },
        ],
      })
    }
    {
      // Inside each column: sections by feature, topic or type, like sub-groups in Notion.
      const g = CARD_GROUPS.find((c) => c.key === this.cardGroup) ?? CARD_GROUPS[0]
      menus.push({
        key: 'menu-cards',
        name: 'Group cards by',
        value: g.label,
        title: 'Group cards by: sections inside each column',
        icon: 'i-outline',
        active: this.cardGroup !== 'level',
        options: CARD_GROUPS.map((c) => ({ key: c.key, label: c.label, hint: c.hint, on: this.cardGroup === c.key })),
      })
    }
    if (this.variants.length) {
      menus.push({
        key: 'menu-variant',
        name: 'Variant',
        value: this.variantKey === '*' ? 'All' : this.variantKey,
        title: 'Variant: which version of the product to show',
        icon: 'i-stack',
        options: [
          ...this.variants.map((v, i) => ({ key: v, label: v, hint: i === 0 ? 'The default' : undefined, on: this.variantKey === v })),
          { key: '*', label: 'All', hint: 'Every variant, screens one variant has tagged', on: this.variantKey === '*' },
        ],
      })
    }
    {
      // What to show, for comments, stories and thoughts alike. Finished ones stay out until asked for.
      const counts = this.progressCounts
      const f = this.progressFilter
      const notDone = counts.open + counts['in-progress'] + counts.ready
      menus.push({
        key: 'menu-show',
        name: 'Show',
        value: f === '' ? 'Open' : f === 'all' ? 'Everything' : PROGRESS_WORDS[f],
        title: 'Show: what to see on the map. Done and Not now are hidden until you pick them.',
        icon: 'i-filter',
        active: f !== '',
        options: [
          { key: '', label: 'Open', hint: 'Everything not done yet', count: notDone, on: f === '' },
          { key: 'in-progress', label: 'In progress', hint: 'A fix proposed, a story partly met', count: counts['in-progress'], on: f === 'in-progress' },
          { key: 'ready', label: 'Ready to test', hint: 'Built. Test it, then approve or reject it.', count: counts.ready, on: f === 'ready' },
          { key: 'done', label: 'Done', hint: 'Fixed comments, done stories, settled thoughts', count: counts.done, on: f === 'done' },
          { key: 'later', label: 'Not now', hint: 'Parked thoughts, stories set aside', count: counts.later, on: f === 'later' },
          { key: 'all', label: 'Everything', hint: 'Done and not done', count: notDone + counts.done + counts.later, on: f === 'all' },
        ],
      })
    }
    const layout = MAP_LAYOUTS.find((l) => l.key === this.mapLayout)
    menus.push({
      key: 'menu-layout',
      name: 'View',
      value: layout?.name.split(':')[0] ?? '',
      title: `${layout?.name.split(':')[0] ?? 'View'}: how the map is drawn ( V )`,
      icon: layout?.icon ?? 'i-columns',
      iconOnly: true,
      right: true,
      options: MAP_LAYOUTS.map((l) => ({ key: l.key, label: l.name.split(':')[0], hint: l.name.split(': ')[1], on: this.mapLayout === l.key })),
    })
    return menus
  },
  /** The variant menu again, for the Sitemap view's header. */
  get sitemapMenus(): MapMenu[] {
    return this.mapMenus.filter((m) => m.key === 'menu-variant').map((m) => ({ ...m, key: 'sitemap-variant' }))
  },
  chooseMenu(menu: string, option: string) {
    this.openMenu = ''
    if (menu === 'sitemap-variant') menu = 'menu-variant'
    if (menu === 'menu-columns') this.setGroupBy(option as 'page' | 'topic')
    else if (menu === 'menu-cards') this.setCardGroup(option as CardGroup)
    else if (menu === 'menu-variant') this.setVariant(option)
    else if (menu === 'menu-show') this.setProgressFilter(option as ProgressFilter)
    else if (menu === 'menu-layout') this.setMapLayout(option as never)
  },
  feedbackWords: { incoming: 'Incoming', proposed: 'Proposed', ready: 'Ready to test', fixed: 'Fixed' } as Record<FeedbackState, string>,
  /** Thoughts, comments and stories on the page in view, per status. */
  get progressCounts(): Record<Progress, number> {
    return cached('progressCounts', () => {
      const counts = Object.fromEntries(PROGRESS.map((p) => [p, 0])) as Record<Progress, number>
      for (const n of this.pageNodes) counts[progressOfNode(n)]++
      const names = this.pageNames
      for (const st of this.stories) {
        const first = this.nodes[st.from[0]]
        if (this.onAll || (first && samePage(pageOf(first, names), this.currentPage))) counts[progressOfStory(st)]++
      }
      return counts
    })
  },
  get hasFeedback(): boolean {
    return this.pageNodes.some(isFeedback)
  },
  /**
   * Standing on the page the comments land on: the Incoming, Proposed and
   * Fixed buttons show only there. The page called Feedback, or one that is
   * mostly comments.
   */
  get onFeedbackPage(): boolean {
    return cached('onFeedbackPage', () => {
      if (this.scopeScreen || this.onAll) return false
      if (samePage(this.currentPage, 'Feedback')) return true
      const nodes = this.pageNodes
      return nodes.length > 0 && nodes.filter(isFeedback).length * 2 > nodes.length
    })
  },
  setProgressFilter(f: ProgressFilter) {
    this.progressFilter = f
    store('grndwrk.progressFilter', f)
    if (this.selected && !this.visibleNodes.includes(this.selected)) this.select(null)
  },
  progressOf(n: GNode): Progress {
    return progressOfNode(n)
  },
  storyProgress(s: Story): Progress {
    return progressOfStory(s)
  },
  feedbackState(n: GNode | null): FeedbackState | null {
    return n ? feedbackState(n) : null
  },
  // Pictures of the screens, and where the product runs to open them.
  shots: [] as Shot[],
  runtime: { app: null as string | null, proxied: false },
  async loadShots() {
    this.shots = await fetchShots()
  },
  async loadRuntime() {
    this.runtime = await fetchRuntime()
  },
  /** Pictures of a screen: the web one first, then iOS ones, newest first. */
  shotsOf(screen: Screen | null): Shot[] {
    if (!screen) return []
    return shotsForScreen(screen, this.shots, this.screens).sort((a, b) => (a.platform === b.platform ? b.taken.localeCompare(a.taken) : a.platform === 'web' ? -1 : 1))
  },
  /** Where the screen opens in the running product, or empty when it cannot be opened from here. */
  openUrl(screen: Screen | null): string {
    const path = screen ? openPath(screen) : ''
    return path && this.runtime.app ? this.runtime.app.replace(/\/+$/, '') + path : ''
  },
  needsExample,
  /** Pictures from the app that no screen claims yet: /sitemap places them, or the person drags them onto a screen. */
  get unplacedShots(): Shot[] {
    return this.shots.filter((s) => s.platform === 'ios' && !this.screens.some((sc) => shotsForScreen(sc, [s], this.screens).length))
  },
  shotTray: false,
  /** The picture being dragged onto a screen, and the screen it is over. */
  draggingShot: null as Shot | null,
  dropOn: '',
  dragShot(shot: Shot, event: DragEvent) {
    this.draggingShot = shot
    event.dataTransfer?.setData('text/plain', shot.file)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  },
  endDragShot() {
    this.draggingShot = null
    this.dropOn = ''
  },
  overScreen(id: string, event: DragEvent) {
    if (!this.draggingShot) return
    event.preventDefault()
    this.dropOn = id
  },
  async dropShot(id: string) {
    const shot = this.draggingShot
    this.endDragShot()
    if (shot) await this.putShot(shot, id)
  },
  /** Write the picture into the screen's shots:, or take it off with an empty id. */
  async putShot(shot: Shot, id: string) {
    const screen = this.screens.find((s) => s.id === id)
    try {
      this.screens = await placeShot(shot.file, id)
      this.flash(screen ? `${shot.key} is on ${screen.title} now` : `${shot.key} is not placed now`)
      if (!this.unplacedShots.length) this.shotTray = false
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Pictures a thread entry shows, as ![name](/shots/ios/App-2.jpg): the ones that exist. */
  entryShots(text: string): Shot[] {
    const files = [...text.matchAll(/!\[[^\]]*\]\(\/?(?:\.grndwrk\/)?shots\/((?:web|ios)\/[^)\s]+)\)/g)].map((m) => {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    })
    return files.map((f) => this.shots.find((s) => s.file === f)).filter((s): s is Shot => !!s)
  },
  /**
   * Every picture an entry shows: pictures pasted into a reply or an answer
   * (`../files/<id>/<name>`), and pictures of screens (`shots/...`). Shaped
   * like a screen's picture, so they open large the same way.
   */
  entryPictures(text: string): Shot[] {
    const pasted = [...text.matchAll(/!\[[^\]]*\]\((?:\.\.\/)+files\/([A-Za-z0-9_-]{1,64})\/([0-9]{10,16}(?:-[0-9]+)?\.(?:png|jpg|gif|webp))\)/g)].map(
      (m): Shot => ({ platform: 'web', key: 'Picture', file: `files/${m[1]}/${m[2]}`, url: `/files/${m[1]}/${m[2]}`, taken: '', pasted: true }),
    )
    return [...pasted, ...this.entryShots(text)]
  },
  /** Upload pictures for a thought, screen or persona; returns the Markdown that shows them, one per line. */
  async uploadPictures(owner: string, files: File[]): Promise<string> {
    const lines: string[] = []
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        lines.push((await uploadImage(owner, file)).markdown)
      } catch (err) {
        this.flash(errorText(err))
      }
    }
    return lines.join('\n')
  },
  /** Text with pictures added at its end, each on its own line. */
  withPictures(text: string, markdown: string): string {
    if (!markdown) return text
    return text.trim() ? `${text.replace(/\s+$/, '')}\n${markdown}` : markdown
  },
  /** The entry's words, without the pictures it shows. */
  entryWords(text: string): string {
    return text.replace(/\n?!\[[^\]]*\]\([^)]*\)\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  },
  /** Whether the screen names this picture itself, so it can be taken off. */
  placedOn(shot: Shot, screen: Screen | null): boolean {
    return !!screen && screen.shots.includes(shot.file)
  },
  // A picture opened large, on top of the app, among the other pictures of its screen.
  viewing: null as Shot | null,
  viewingSet: [] as Shot[],
  viewShot(shot: Shot, set: Shot[]) {
    this.viewing = shot
    this.viewingSet = set
  },
  closeShot() {
    this.viewing = null
    this.viewingSet = []
  },
  stepShot(by: number) {
    const set = this.viewingSet
    if (!this.viewing || set.length < 2) return
    const at = set.findIndex((s) => s.url === this.viewing!.url)
    this.viewing = set[(at + by + set.length) % set.length]
  },
  shotLabel(shot: Shot): string {
    if (shot.pasted) return 'Picture'
    const when = new Date(shot.taken).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    return shot.platform === 'web' ? `Web, ${when}` : `iOS, ${shot.key}, ${when}`
  },
  // Phones on the network asking to send comments. The person here allows them, and the phone gets the code.
  pairRequests: [] as PairRequest[],
  async loadPairRequests() {
    this.pairRequests = await fetchPairRequests()
  },
  addPairRequest(request: PairRequest) {
    this.pairRequests = [...this.pairRequests.filter((p) => p.id !== request.id), request]
  },
  dropPairRequest(id: string) {
    this.pairRequests = this.pairRequests.filter((p) => p.id !== id)
  },
  async answerPair(id: string, allow: boolean) {
    const request = this.pairRequests.find((p) => p.id === id)
    this.dropPairRequest(id)
    try {
      await answerPairRequest(id, allow)
    } catch {
      return this.flash('That request ran out. Ask again from the phone.')
    }
    this.flash(allow ? `${request?.device ?? 'The phone'} can send comments now` : 'Not allowed')
  },
  // Local sites whose Comment button sent a comment, waiting to be allowed. The comment waits in that browser and goes once allowed.
  siteRequests: [] as string[],
  /** Sites that may send comments, shown in the Comments menu, where one can be removed. */
  allowedSites: [] as AllowedSite[],
  // Colleagues away from the Wi-Fi, through the team's relay: who joined, open invites, and a new invite with its QR code.
  relay: { connected: false } as RelayInfo,
  invited: null as { name: string; link: string; qr: string } | null,
  async loadRelay() {
    this.relay = await fetchRelay()
  },
  async invite(name: string) {
    try {
      const { name: who, link } = await inviteColleague(name)
      this.invited = { name: who, link, qr: qrPath(link) }
      await this.loadRelay()
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async removeColleague(kind: 'phones' | 'invites', id: string) {
    try {
      this.relay = await removeFromRelay(kind, id)
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async loadSiteRequests() {
    const { asking, allowed } = await fetchSites()
    this.siteRequests = asking
    this.allowedSites = allowed
  },
  async removeAllowedSite(origin: string) {
    try {
      this.allowedSites = (await removeSite(origin)).allowed
      this.flash(`${this.siteName(origin)} removed. Its next comment asks again.`)
    } catch {
      void this.loadSiteRequests()
    }
  },
  addSiteRequest(origin: string) {
    if (!this.siteRequests.includes(origin)) this.siteRequests = [...this.siteRequests, origin]
  },
  dropSiteRequest(origin: string) {
    this.siteRequests = this.siteRequests.filter((o) => o !== origin)
  },
  siteName(origin: string) {
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  },
  async answerSite(origin: string, allow: boolean) {
    this.dropSiteRequest(origin)
    try {
      this.allowedSites = (await answerSiteRequest(origin, allow)).allowed
    } catch {
      return this.flash('That request is gone. Send the comment again.')
    }
    this.flash(allow ? `${this.siteName(origin)} can send comments now. Its waiting comment arrives shortly.` : 'Not allowed')
  },
  /** Mark the open comment fixed, or take that back. Only ever done by the person. */
  async markFixed(fixed: boolean) {
    const node = this.selected
    if (!node) return
    try {
      this.upsert(await updateNode(node.id, { fixed: fixed ? today() : '' }))
    } catch (err) {
      return this.flash(errorText(err))
    }
    if (fixed && !showsProgress(this.progressFilter, 'done')) {
      this.select(null)
      this.flash('Marked fixed. Show: Done in the toolbar lists what is finished.')
    } else if (!fixed && this.progressFilter === 'done') {
      this.select(null)
      this.flash('Back with the open ones')
    }
  },
  /** A proposed fix was built: it is ready to test, in the app or here. */
  async markBuilt() {
    const node = this.selected
    if (!node) return
    try {
      this.upsert(await updateNode(node.id, { built: today() }))
      this.flash('Ready to test. It shows on the phone it came from, with Approve and Reject.')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  // Testing a built fix in the map: Claude's "To test:" steps as a checklist.
  /** What changed and the steps to test it, from a Claude entry. */
  testSteps(text: string): { fix: string; steps: string[] } {
    return testSteps(this.entryWords(text))
  },
  /** The entry whose steps can be tested now: Claude's last word on a comment that is ready to test. */
  get testableEntry(): number {
    if (!this.selected || feedbackState(this.selected) !== 'ready') return -1
    const t = this.thread
    for (let i = t.length - 1; i >= 0; i--) if (t[i].who === 'claude') return testSteps(t[i].text).steps.length ? i : -1
    return -1
  },
  /** Each step marked works or not, per comment and entry, kept in this browser until the comment is settled. */
  testChecks: readStored<Record<string, Record<number, 'ok' | 'bad'>>>('grndwrk.testChecks', {}),
  stepMark(entry: number, step: number): 'ok' | 'bad' | undefined {
    return this.testChecks[`${this.selectedId}:${entry}`]?.[step]
  },
  markStep(entry: number, step: number, mark: 'ok' | 'bad') {
    const key = `${this.selectedId}:${entry}`
    const marks = { ...(this.testChecks[key] ?? {}) }
    if (marks[step] === mark) delete marks[step]
    else marks[step] = mark
    this.testChecks = { ...this.testChecks, [key]: marks }
    store('grndwrk.testChecks', this.testChecks)
  },
  /** What to say when it does not work: the steps marked as not working, to add to. */
  failedStepsNote(entry: number, steps: string[]): string {
    const bad = steps.map((s, n) => (this.stepMark(entry, n) === 'bad' ? `Step ${n + 1} (${s.length > 60 ? s.slice(0, 57) + '...' : s}): ` : '')).filter(Boolean)
    return bad.join('\n')
  },
  /** The person tested the fix here: fixed, or back to the agent with what is still wrong. */
  async testedHere(works: boolean, note = '') {
    const node = this.selected
    if (!node) return
    try {
      const { node: changed } = await markTested(node.id, works, note)
      const key = `${node.id}:`
      this.testChecks = Object.fromEntries(Object.entries(this.testChecks).filter(([k]) => !k.startsWith(key)))
      store('grndwrk.testChecks', this.testChecks)
      this.upsert(changed)
    } catch (err) {
      return this.flash(errorText(err))
    }
    if (works && !showsProgress(this.progressFilter, 'done')) {
      this.select(null)
      this.flash('Works: marked fixed. Show: Done in the toolbar lists what is finished.')
    } else if (!works) this.flash('Back to your agent, with what is still wrong. The next /feedback picks it up.')
  },
  // Working on one part: the whole map stays one map, a screen is a filter on it.
  /** The screen being worked on, or null for the whole product. */
  scope: readStored<string | null>('grndwrk.scope', null),
  get scopeScreen(): Screen | null {
    return this.scope ? (this.screens.find((s) => s.id === this.scope) ?? null) : null
  },
  /** Ids of the thoughts about the scoped screen: marked with screen:, or comments made on it. */
  get scopeIds(): Set<string> {
    const s = this.scopeScreen
    if (!s) return new Set()
    const nodes = Object.values(this.nodes)
    return new Set([...nodes.filter((n) => n.extra?.screen === s.id), ...commentsForScreen(s, nodes)].map((n) => n.id))
  },
  inScope(n: GNode): boolean {
    return !this.scopeScreen || this.scopeIds.has(n.id)
  },
  gapInScope(g: Gap): boolean {
    return !this.scopeScreen || g.screen === this.scopeScreen.id
  },
  /** How many thoughts are about a screen. */
  thoughtsOn(id: string): number {
    return Object.values(this.nodes).filter((n) => n.extra?.screen === id).length
  },
  setScope(id: string | null) {
    this.scope = id
    store('grndwrk.scope', id)
    this.select(null)
    const s = this.scopeScreen
    this.flash(s ? `Working on ${s.title}. New thoughts belong to it.` : 'The whole product')
  },
  // The part picker: search the screens, or walk the tree.
  scopeOpen: false,
  scopeQuery: '',
  scopeIndex: 0,
  /** Whole product first, then every screen with where it sits; filtered while searching. */
  get scopeOptions(): { id: string | null; title: string; path: string; depth: number; count: number }[] {
    const byId = new Map(this.viewScreens.map((s) => [s.id, s]))
    const path = (s: Screen) => {
      const names: string[] = []
      let p = s.parent ? byId.get(s.parent) : undefined
      while (p && names.length < 6) {
        names.unshift(p.title)
        p = p.parent ? byId.get(p.parent) : undefined
      }
      return names.join(' › ')
    }
    const all = this.screenRows.map(({ screen, depth }) => ({ id: screen.id, title: screen.title, path: path(screen), depth, count: this.thoughtsOn(screen.id) }))
    const q = this.scopeQuery.trim().toLowerCase()
    if (!q) return [{ id: null, title: 'Whole product', path: '', depth: 0, count: 0 }, ...all]
    return all
      .filter((o) => o.title.toLowerCase().includes(q) || o.path.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)))
  },
  openScopePicker() {
    this.scopeOpen = true
    this.scopeQuery = ''
    this.scopeIndex = Math.max(0, this.scopeOptions.findIndex((o) => o.id === this.scope))
    focusWhenVisible('scope-search')
  },
  moveScope(delta: number) {
    const n = this.scopeOptions.length
    if (n) this.scopeIndex = (this.scopeIndex + delta + n) % n
    Alpine.nextTick(() => document.querySelector('#scope-options [data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
  },
  chooseScope(id?: string | null) {
    const pick = id !== undefined ? id : this.scopeOptions[this.scopeIndex]?.id
    this.scopeOpen = false
    if (pick === undefined) return
    if (pick !== this.scope) this.setScope(pick)
  },
  /** Open the map on one screen, from the sitemap. */
  workOn(id: string) {
    this.setScope(id)
    this.setView('map')
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
  /** The questions in one entry of a thread, each with its options and whether it is answered. */
  entryQuestions(body: string, entry: number): Question[] {
    return questions(body).filter((q) => q.entry === entry)
  },
  /** How many questions wait in a body. Several mean each is answered on its own. */
  openCount(body: string): number {
    return openQuestions(body)
  },
  /** A **You** entry that answers one question quotes it first: the quote, and the answer. */
  youParts(text: string): { quote: string; rest: string } {
    const lines = text.split('\n')
    let n = 0
    while (n < lines.length && /^\s*>/.test(lines[n])) n++
    return { quote: lines.slice(0, n).map((l) => l.replace(/^\s*>\s?/, '')).join(' ').trim(), rest: lines.slice(n).join('\n').trim() }
  },
  /** Answer one of Claude's questions on the open screen: the options picked and the words, quoting it. */
  async answerScreenQuestion(q: Question, text: string) {
    await this.sendScreenReply({ q, text })
  },
  /** Answer one of Claude's questions on the open card: the options picked and the words, quoting it. */
  async answerQuestion(q: Question, text: string) {
    await this.sendReply({ q, text })
  },
  /** The open question at this place in the thread, or null when it is answered or gone. */
  replyQuestion(body: string, to: { entry: number; index: number } | null): Question | null {
    if (!to) return null
    return questions(body).find((q) => q.entry === to.entry && q.index === to.index && q.open) ?? null
  },
  /** Cards where Claude is waiting for an answer, in list order. */
  get questionIds(): string[] {
    return cached('questionIds', () => {
      return groupForList(Object.values(this.nodes).filter((n) => !isFixed(n)), '')
        .flatMap((g) => g.nodes)
        .filter((n) => openQuestions(n.body) > 0)
        .map((n) => n.id)
    })
  },
  /** The project's name for the rail: project.md's name, or the folder's. */
  get projectLabel(): string {
    const name = typeof this.project.name === 'string' ? this.project.name.trim() : ''
    return name || (typeof this.project.folder === 'string' ? this.project.folder : '')
  },
  /** The badge's letters: as set in project.md (`initials:`), else the first of each word, or the first two of one word. */
  get projectInitials(): string {
    const set = typeof this.project.initials === 'string' ? this.project.initials.trim() : ''
    if (set) return set.toUpperCase()
    const words = this.projectLabel.split(/[\s_.-]+/).filter(Boolean)
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)
    return letters.toUpperCase()
  },
  /** The badge's color: as set in project.md (`color:`), else a calm one of its own per project, so two maps side by side look different at a glance. */
  get projectColor(): string {
    const set = typeof this.project.color === 'string' ? this.project.color.trim() : ''
    if (/^#[0-9a-f]{6}$/i.test(set)) return set
    return this.autoColor(this.projectLabel)
  },
  /** The color a name gets when none is set. */
  autoColor(name: string): string {
    let h = 0
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return `hsl(${h % 360} 45% 42%)`
  },
  /** Colors to pick for the badge: calm, readable with white letters in light and dark. */
  badgeColors: ['#64748b', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#ca8a04', '#ea580c', '#e11d48', '#db2777', '#7c3aed'],
  /** Save the badge: name, initials and color in project.md. Empty initials or color go back to the default. */
  async saveBadge(badge: { name: string; initials: string; color: string }) {
    try {
      this.project = await saveProjectFields(badge)
      this.flash('Saved in project.md')
      return true
    } catch (err) {
      this.flash(errorText(err))
      return false
    }
  },
  /** A thread entry split into its question and the options Claude gave. */
  options: questionOptions,
  answerText,
  hasQuestion(id: string): boolean {
    const n = this.nodes[id]
    return !!n && openQuestions(n.body) > 0
  },
  pageCount(page: string): number {
    const names = this.pageNames
    return Object.values(this.nodes).filter((n) => samePage(pageOf(n, names), page)).length
  },
  get selected(): GNode | null {
    return this.selectedId ? (this.nodes[this.selectedId] ?? null) : null
  },
  /** Existing topic names, for suggestions in the panel. */
  get topicNames(): string[] {
    return [...topicColumns(this.visibleNodes).values()].filter((c) => c.key).map((c) => c.name)
  },
  get listGroups(): ListGroup[] {
    return cached('listGroups', () => {
      const groups = groupForList(this.visibleNodes, this.query)
      if (!this.onlyAttention) return groups
      return groups.filter((g) => this.needsAttention(g))
    })
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
    return cached('visibleStories', () => {
      const f = this.progressFilter
      const wanted = (list: Story[]) => list.filter((st) => showsProgress(f, progressOfStory(st)))
      if (this.scopeScreen) return wanted(storiesForScreen(this.scopeScreen, this.stories))
      // A story only screens outside the variant in view cover belongs to the other variant.
      const hidden = this.hiddenScreens
      let shown = this.stories
      if (hidden.size) {
        // Which screens cover each story, worked out once per screen rather than per story and screen.
        const covering = new Map<string, string[]>()
        for (const sc of this.screens) for (const st of storiesForScreen(sc, this.stories)) covering.set(st.id, [...(covering.get(st.id) ?? []), sc.id])
        shown = this.stories.filter((st) => {
          const by = covering.get(st.id) ?? []
          return !by.length || by.some((id) => !hidden.has(id))
        })
      }
      if (this.onAll) return wanted(shown)
      const names = this.pageNames
      return wanted(shown).filter((st) => {
        const first = this.nodes[st.from[0]]
        return first && samePage(pageOf(first, names), this.currentPage)
      })
    })
  },
  selectStory(id: string) {
    this.select(null)
    this.selectedStoryId = id
    this.storyEditing = false
    this.setDetailsMinimized(false)
  },
  // Stories, written and changed in the map as well as by Claude.
  /** Whether the open story's text is being edited. */
  storyEditing: false,
  storyText: '',
  storyLabel(st: Story): string {
    return storyStatusLabel(st)
  },
  criteria(st: Story | null): Criterion[] {
    return st ? criteriaOf(st.body) : []
  },
  putStory(st: Story) {
    this.stories = this.stories.some((x) => x.id === st.id) ? this.stories.map((x) => (x.id === st.id ? st : x)) : [...this.stories, st]
  },
  async changeStory(edit: { title?: string; status?: string; body?: string; later?: string | null }) {
    const st = this.selectedStory
    if (!st) return
    try {
      this.putStory(await saveStory(st.id, edit))
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Tick a criterion; the status follows: all met is done, some is partly, none is not started. */
  async tickStory(c: Criterion, met: boolean) {
    const st = this.selectedStory
    if (!st) return
    const body = tickCriterion(st.body, c.line, met)
    const all = criteriaOf(body)
    const n = all.filter((x) => x.met).length
    const status = n === all.length ? 'done' : n ? 'partial' : 'not-started'
    await this.changeStory({ body, status })
  },
  editStoryText() {
    this.storyText = this.selectedStory?.body ?? ''
    this.storyEditing = true
    focusWhenVisible('story-text')
  },
  async saveStoryText() {
    this.storyEditing = false
    if (this.selectedStory && this.storyText !== this.selectedStory.body) await this.changeStory({ body: this.storyText })
  },
  /** Partly met: copy an instruction for Claude to build exactly what is not met yet. */
  storyBuildRest() {
    const st = this.selectedStory
    if (!st) return
    const open = criteriaOf(st.body).filter((c) => !c.met)
    this.showPrompt(
      `Build the rest of "${st.title}"`,
      [
        `Build the rest of story ${st.id} (${st.title}), in .grndwrk/stories/${st.id}.md. These acceptance criteria are not met yet:`,
        ...open.map((c) => `- ${c.text}`),
        '',
        'When one is met in the code, tick it in the story (- [x]); when all are, set status: done. Fill applies_to with the routes or files.',
      ].join('\n'),
    )
  },
  /** Partly met is enough: done now, and each criterion not met becomes a parked thought, so it is not lost. */
  async storyEnough() {
    const st = this.selectedStory
    if (!st) return
    const open = criteriaOf(st.body).filter((c) => !c.met)
    for (const c of open) {
      try {
        this.upsert(await createNode({ title: c.text, type: 'feature', status: 'parked', links: st.from.filter((id) => this.nodes[id]).slice(0, 1), body: `Not done when story ${st.id} (${st.title}) was called enough on ${today()}.\n` }))
      } catch (err) {
        return this.flash(errorText(err))
      }
    }
    await this.changeStory({ status: 'done', later: null })
    this.flash(open.length ? `Done. ${open.length === 1 ? 'What was not met is' : 'What was not met are'} parked thoughts now.` : 'Done.')
  },
  /** Set aside: still partly done, but chosen not to do now, so it leaves what is left. */
  async storyNotNow(back = false) {
    await this.changeStory({ later: back ? null : today() })
    this.flash(back ? 'Back with what is left' : 'Set aside. Show: Not now lists it.')
  },
  /** A story from a thought: its title to start from, the thought as where it came from. */
  async storyFrom(node: GNode | null) {
    if (!node) return
    try {
      const st = await createStory({ title: node.title, from: [node.id] })
      this.putStory(st)
      this.selectStory(st.id)
      this.editStoryText()
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  get selectedGap(): Gap | null {
    return this.readiness?.gaps.find((g) => g.id === this.selectedGapId) ?? null
  },
  /** Gaps on the page in view. Everything on All. */
  get visibleGaps(): Gap[] {
    return cached('visibleGaps', () => {
      const hidden = this.hiddenScreens
      const gaps = (this.readiness?.gaps ?? []).filter((g) => !(g.screen && hidden.has(g.screen)))
      // Gaps are what is open by nature: shown with everything not finished, or with all.
      if (this.progressFilter !== '' && this.progressFilter !== 'all') return []
      if (this.scopeScreen) return gaps.filter((g) => this.gapInScope(g))
      if (this.onAll) return gaps
      const first = this.pageNames[0]
      return gaps.filter((g) => samePage(g.page || first, this.currentPage))
    })
  },
  /** Open gaps per topic, for the counts in the list. */
  missingIn(topicKey: string): number {
    return this.visibleGaps.filter((g) => !g.answered_by && (g.topic ?? '').trim().toLowerCase() === topicKey).length
  },
  /** The report as HTML. It is a local file written by /readiness, shown as is. */
  get reportHtml(): string {
    const body = this.readiness?.report?.body ?? ''
    return md(body)
  },
  get briefHtml(): string {
    return linkIds(md(stripFrontmatter(this.brief ?? '')))
  },
  get briefWritten(): string {
    return /^---[\s\S]*?\bwritten:\s*(\S+)[\s\S]*?---/.exec(this.brief ?? '')?.[1] ?? ''
  },
  get starterHtml(): string {
    return md(stripFrontmatter(this.starter ?? ''))
  },
  /** The story's text; its acceptance criteria are shown as checkboxes above it, so not again here. */
  storyHtml(story: Story): string {
    const lines = story.body.split('\n')
    const out: string[] = []
    let skipping = false
    for (const l of lines) {
      if (/^#{1,6}\s/.test(l)) skipping = /^#{1,6}\s+acceptance\b/i.test(l) && criteriaOf(story.body).length > 0
      if (!skipping) out.push(l)
    }
    return md(out.join('\n'))
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
    return cached('screenRows', () => {
      return screenTree(this.viewScreens)
    })
  },
  /** The open screen, or the first one. */
  get screen(): Screen | null {
    return this.viewScreens.find((s) => s.id === this.screenId) ?? this.screenRows[0]?.screen ?? null
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
  questionsOn(screen: { body: string }): number {
    return openQuestions(screen.body)
  },
  /** Screens that link here, and the parent, so the way in is visible too. */
  cameFrom(screen: Screen): Screen[] {
    return this.viewScreens.filter((s) => s.id !== screen.id && (s.leads_to.includes(screen.id) || s.id === screen.parent))
  },
  get screenThread(): Entry[] {
    return this.screen ? splitBody(this.screen.body).entries : []
  },
  get screenNotesHtml(): string {
    const notes = this.screen ? splitBody(this.screen.body).notes.trim() : ''
    return notes ? linkIds(md(notes)) : ''
  },
  get sitemapSummary(): { screens: number; noStory: number; questions: number; guesses: number; unreadable: number } {
    return {
      screens: this.viewScreens.length,
      noStory: this.viewScreens.filter((s) => !s.error && s.status !== 'planned' && !this.storiesOf(s).length).length,
      questions: this.viewScreens.reduce((n, s) => n + openQuestions(s.body), 0),
      guesses: this.viewScreens.filter((s) => s.source === 'inferred').length,
      unreadable: this.screens.filter((s) => s.error).length,
    }
  },
  /** The sitemap as boxes, tree lines, and the links out of the open screen. */
  get sitemapDrawing() {
    return cached('sitemapDrawing', () => {
      const layout = layoutSitemap(this.viewScreens)
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
        ...tree.map((d) => `<path d="${d}" fill="none" class="sitemap-tree" stroke-width="1.5" />`),
        ...links.map((l) => `<path d="${l.d}" fill="none" stroke="#0d99ff" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#sitemap-arrow)" />`),
      ].join('')
      return {
        boxes: layout.boxes.map((b) => ({ ...b, x: b.x + pad, y: b.y + pad, screen: this.viewScreens.find((s: Screen) => s.id === b.id) ?? null })),
        svg,
        width: layout.width + pad * 2,
        height: layout.height + pad * 2,
      }
    })
  },
  setSitemapLayout(layout: 'drawn' | 'list') {
    this.sitemapLayout = layout
    store('grndwrk.sitemapLayout', layout)
  },
  zoomSitemap(by: number | 'fit') {
    if (by === 'fit') {
      const pane = document.getElementById('sitemap-drawn')
      const d = this.sitemapDrawing
      by = pane ? Math.min(1, (pane.clientWidth - 16) / d.width, (pane.clientHeight - 16) / d.height) : 1
    } else by = this.sitemapZoom * by
    this.sitemapZoom = Math.round(Math.min(1.5, Math.max(0.3, by)) * 100) / 100
    store('grndwrk.sitemapZoom', this.sitemapZoom)
  },
  selectScreen(id: string) {
    this.screenId = id
    this.screenReply = ''
    this.screenStatus = ''
    this.screenPersonaOpen = false
    this.screenPersona = ''
    store('grndwrk.screen', id)
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
  async sendScreenReply(answer?: { q: Question; text: string }) {
    const s = this.screen
    const text = (answer ? answer.text : this.screenReply).trim()
    if (!s || !text || this.sending) return
    this.sending = true
    this.screenStatus = 'Saving...'
    try {
      const target = answer && this.replyQuestion(s.body, { entry: answer.q.entry, index: answer.q.index })
      if (answer && !target) return
      this.putScreen(await updateScreen(s.id, { body: target ? appendAnswer(s.body, target, text, today()) : appendEntry(s.body, 'you', text, today()) }))
      if (!answer) this.screenReply = ''
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
  // Personas: the people the product is for, one file each. Screens name them in `for:`.
  personas: [] as Persona[],
  personaId: readStored<string | null>('grndwrk.persona', null),
  personaReply: '',
  personaStatus: '',
  newPersona: '',
  /** The persona whose Delete was pressed once; a second press deletes it. */
  deletingPersona: '',
  /** The overview /personas writes: what the matrices cannot say. Null until it has run. */
  personaOverview: null as string | null,
  /** What the Personas view shows: the overview (matrices), the segments, or a persona. */
  personaPane: readStored<'overview' | 'segments' | 'persona'>('grndwrk.personaPane', 'overview'),
  segments: [] as Segment[],
  async loadPersonas() {
    try {
      const [personas, segments, overview] = await Promise.all([fetchPersonas(), fetchSegments(), fetchOutput('personas.md')])
      this.personas = personas
      this.segments = segments
      this.personaOverview = overview
    } catch {
      // Offline: the next reconnect loads them.
    }
  },
  /** Primary first, then secondary, occasional and the rest; by name within a tier. */
  get personaList(): Persona[] {
    // A future tier ("primary (future)") comes after the tier as it is today.
    const rank = (p: Persona) => {
      const i = PERSONA_TIERS.findIndex((t) => p.tier.toLowerCase().startsWith(t))
      return (i === -1 ? PERSONA_TIERS.length : i) + (/future/i.test(p.tier) ? 0.5 : 0)
    }
    return [...this.personas].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  },
  get personaOverviewHtml(): string {
    return this.personaOverview ? linkIds(md(stripFrontmatter(this.personaOverview))) : ''
  },
  /** The tiers to pick from, with the persona's own when it is another, like "primary (future)". */
  tierOptions(p: Persona): { value: string; label: string }[] {
    const tiers: string[] = ['', ...PERSONA_TIERS]
    if (!tiers.includes(p.tier)) tiers.push(p.tier)
    return tiers.map((t) => ({ value: t, label: t ? t[0].toUpperCase() + t.slice(1) : 'No tier' }))
  },
  isGuess(p: Persona | null): boolean {
    return !!p && isGuess(p)
  },
  showPersonaPane(pane: 'overview' | 'segments' | 'persona') {
    this.personaPane = pane
    this.deletingPersona = ''
    this.deletingSegment = ''
    store('grndwrk.personaPane', pane)
  },
  // The overview: personas against segments, themes or the product's areas, filtered by size and customer type.
  overviewTab: readStored<'segments' | 'themes' | 'areas'>('grndwrk.overviewTab', 'segments'),
  sizeBand: readStored<string>('grndwrk.sizeBand', ''),
  segmentType: readStored<string>('grndwrk.segmentType', ''),
  setOverview(field: 'overviewTab' | 'sizeBand' | 'segmentType', value: string) {
    ;(this as Record<string, unknown>)[field] = value
    store(`grndwrk.${field}`, value)
  },
  sizeBands: SIZE_BANDS.map(([label]) => label),
  segmentTypes: SEGMENT_TYPES,
  segmentHow: SEGMENT_HOW,
  employers: PERSONA_EMPLOYERS,
  devices: PERSONA_DEVICES,
  choices: PERSONA_CHOICES,
  sizeLabel,
  /** How common a persona is in a segment, in words. */
  howLabel(how: string): string {
    return ({ most: 'Most common', common: 'Common', present: 'Present', none: 'Not here' } as Record<string, string>)[how] ?? how
  },
  /** A field's value as a label: "Service provider", "On incident". */
  valueLabel(value: string): string {
    return value ? (value[0].toUpperCase() + value.slice(1)).replace(/^Fm\b/, 'FM') : ''
  },
  /** Every readable segment, smallest customers first; one of unknown size last. */
  get sortedSegments(): Segment[] {
    const size = (s: Segment) => s.size_min || s.size_max || Infinity
    return this.segments.filter((s) => !s.error).sort((a, b) => size(a) - size(b) || a.name.localeCompare(b.name))
  },
  /** The segments in view, by the size and type filters. */
  get viewSegments(): Segment[] {
    return this.sortedSegments.filter((s) => (!this.sizeBand || inBand(s, this.sizeBand)) && (!this.segmentType || s.type === this.segmentType))
  },
  /** The personas in view: with the size or type filter on, those present in a segment in view. */
  get viewPersonas(): Persona[] {
    const ids = new Set(this.viewSegments.map((s) => s.id))
    const filtered = !!(this.sizeBand || this.segmentType)
    return this.personaList.filter((p) => !p.error && (!filtered || Object.entries(p.segments).some(([id, v]) => ids.has(id) && v.how !== 'none')))
  },
  /** Every theme any persona has, the most asked about first. */
  get allThemes(): string[] {
    const counts = new Map<string, number>()
    const only = new Set(this.viewSegments.map((s) => s.id))
    for (const p of this.viewPersonas) for (const [t, n] of themeCounts(p, this.segments, this.sizeBand || this.segmentType ? only : null)) counts.set(t, (counts.get(t) ?? 0) + n + 0.001)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
  },
  /** How often a persona asked about a theme, in the segments in view. */
  themeCount(p: Persona, theme: string): number | null {
    const only = this.sizeBand || this.segmentType ? new Set(this.viewSegments.map((s) => s.id)) : null
    const n = themeCounts(p, this.segments, only).get(theme)
    return n === undefined ? null : n
  },
  /** Every area of the product any persona lives in or visits. */
  get allAreas(): string[] {
    const seen: string[] = []
    for (const p of this.viewPersonas) for (const a of [...p.lives_in, ...p.visits]) if (!seen.some((x) => x.toLowerCase() === a.toLowerCase())) seen.push(a)
    return seen
  },
  areaMark(p: Persona, area: string): string {
    const has = (xs: string[]) => xs.some((x) => x.toLowerCase() === area.toLowerCase())
    return has(p.lives_in) ? '●' : has(p.visits) ? '○' : ''
  },
  /** A persona's evidence, each line with its segment's name. */
  evidenceOf(p: Persona): (Evidence & { segmentName: string })[] {
    return readEvidence(p.evidence, this.segments).map((e) => ({ ...e, segmentName: this.segments.find((s) => s.id === e.segment)?.name ?? '' }))
  },
  /** Names on screens that are no persona yet: to make personas, merge into one, or take off, all at once. */
  get looseNames(): { name: string; screens: Screen[] }[] {
    return looseNames(this.screens.filter((s) => !s.error), this.personas)
  },
  async settle(name: string, to: string) {
    if (!to) return
    try {
      const { persona } = await settleName(name, to)
      await Promise.all([this.loadScreens(), this.loadPersonas()])
      this.flash(to === 'remove' ? `Took ${name} off its screens` : to === 'new' ? `${name} is a persona now` : `Merged into ${persona?.name ?? 'the persona'}`)
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  // Segments: kinds of customers, edited in place in the Personas view.
  newSegment: '',
  deletingSegment: '',
  async addSegment() {
    const name = this.newSegment.trim()
    if (!name) return
    try {
      this.segments.push(await createSegment(name))
      this.newSegment = ''
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async editSegment(id: string, input: SegmentInput) {
    const before = this.segments.find((s) => s.id === id)
    if (!before) return
    const changed = Object.entries(input).some(([k, v]) => JSON.stringify(v) !== JSON.stringify((before as unknown as Record<string, unknown>)[k]))
    if (!changed) return
    try {
      const next = await saveSegment(id, input)
      this.segments = this.segments.map((s) => (s.id === id ? next : s))
      this.flash('Saved')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async removeSegment(id: string) {
    if (this.deletingSegment !== id) {
      this.deletingSegment = id
      return
    }
    try {
      await deleteSegment(id)
      this.segments = this.segments.filter((s) => s.id !== id)
      this.deletingSegment = ''
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Words separated by commas, as a list. */
  words(text: string): string[] {
    return text.split(',').map((x) => x.trim()).filter(Boolean)
  },
  /** A number typed with spaces or a plus, like "10 000+"; 0 when empty. */
  sizeNumber(text: string): number {
    const n = Number(text.replace(/[\s+_]/g, ''))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  },
  get persona(): Persona | null {
    return this.personas.find((p) => p.id === this.personaId) ?? this.personaList[0] ?? null
  },
  selectPersona(id: string) {
    this.personaPane = 'persona'
    store('grndwrk.personaPane', 'persona')
    this.personaEditing = ''
    this.personaId = id
    this.personaReply = ''
    this.personaStatus = ''
    this.deletingPersona = ''
    store('grndwrk.persona', id)
  },
  openPersona(id: string) {
    this.selectPersona(id)
    this.setView('personas')
  },
  /** The persona a name in a screen's `for:` stands for, if any. */
  personaFor(name: string): Persona | null {
    return personaNamed(name, this.personas)
  },
  /** The screens in view meant for a persona. */
  screensFor(p: Persona): Screen[] {
    return screensForPersona(p, this.viewScreens)
  },
  /** Personas a screen does not name yet, to add to its `for:` with one click. */
  personasToAdd(screen: Screen | null): Persona[] {
    return screen ? this.personaList.filter((p) => !p.error && !screen.audience.some((a) => personaNamed(a, [p]))) : []
  },
  personaSections: SECTIONS,
  /** The section being edited as Markdown; the others read as formatted text. */
  personaEditing: '',
  editSection(key: string) {
    if (!this.persona?.error) this.personaEditing = key
  },
  /** A section's Markdown as safe HTML: bold labels, lists, links. */
  sectionHtml(text: string): string {
    return linkIds(md(text))
  },
  /** Grow a text field to fit what it holds, so a long section reads whole. */
  fitField(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  },
  get personaThread(): Entry[] {
    return this.persona ? splitBody(this.persona.body).entries : []
  },
  /** Notes beyond the three sections, read only here. */
  get personaNotesHtml(): string {
    const rest = this.persona ? readSections(splitBody(this.persona.body).notes).rest : ''
    return rest ? linkIds(md(rest)) : ''
  },
  putPersona(p: Persona) {
    const i = this.personas.findIndex((x) => x.id === p.id)
    if (i >= 0) this.personas[i] = p
    else this.personas.push(p)
  },
  /** Save a field the person changed. It becomes theirs: /personas never rewrites it. */
  async savePersona(field: Exclude<keyof PersonaInput, PersonaList | 'segments' | 'confirmed' | 'body'>, value: string) {
    const p = this.persona
    if (!p || value.trim() === String(p[field] ?? '').trim()) return
    if (field === 'name' && !value.trim()) return this.flash('A persona needs a name')
    await this.patchPersona({ [field]: value })
    if (field === 'name') void this.loadScreens()
  },
  async patchPersona(input: PersonaInput) {
    const p = this.persona
    if (!p) return
    try {
      this.putPersona(await updatePersona(p.id, input))
      this.flash('Saved')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Add or take off one value of a list field: employed by, device. */
  togglePersona(field: PersonaList, value: string) {
    const p = this.persona
    if (!p) return
    const has = p[field].some((x) => x.toLowerCase() === value.toLowerCase())
    void this.patchPersona({ [field]: has ? p[field].filter((x) => x.toLowerCase() !== value.toLowerCase()) : [...p[field], value] })
  },
  /** Save a list field typed as words separated by commas: lives in, visits, themes. */
  savePersonaList(field: PersonaList, text: string) {
    const p = this.persona
    if (!p) return
    const next = this.words(text)
    if (next.join('\n') !== p[field].join('\n')) void this.patchPersona({ [field]: next })
  },
  /** How common the persona is in a segment, and who wears the hat there. */
  savePersonaSegment(segment: string, how: string | null, titles: string | null) {
    const p = this.persona
    if (!p) return
    const was = p.segments[segment] ?? { how: '', titles: [] }
    const next = { how: how ?? was.how, titles: titles === null ? was.titles : this.words(titles) }
    if (next.how === was.how && next.titles.join('\n') === was.titles.join('\n')) return
    void this.patchPersona({ segments: { ...p.segments, [segment]: next } })
  },
  /** The person says the guess is right, or takes that back. */
  async confirmPersona(confirmed: boolean) {
    const p = this.persona
    if (!p) return
    try {
      this.putPersona(await updatePersona(p.id, { confirmed }))
      this.flash(confirmed ? 'Confirmed' : 'Back to a guess')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async addPersona() {
    const name = this.newPersona.trim()
    if (!name) return
    try {
      const p = await createPersona({ name })
      this.putPersona(p)
      this.newPersona = ''
      this.selectPersona(p.id)
      focusWhenVisible('persona-summary')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async removePersona(id: string) {
    if (this.deletingPersona !== id) {
      this.deletingPersona = id
      return
    }
    try {
      const name = this.personas.find((p) => p.id === id)?.name
      await deletePersona(id)
      // Screens link only to personas: the name comes off them too.
      if (name) await settleName(name, 'remove')
      this.personas = this.personas.filter((p) => p.id !== id)
      this.deletingPersona = ''
      void this.loadScreens()
      this.flash('Deleted, and taken off its screens.')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Put a persona in the open screen's `for:`, or take it off. */
  async addPersonaToScreen(p: Persona) {
    const s = this.screen
    if (!s) return
    await this.saveScreen('audience', [...s.audience, p.name].join(', '))
  },
  /** A new persona named from the open screen's "Who it is for", put on that screen. */
  screenPersonaOpen: false,
  screenPersona: '',
  async addPersonaFromScreen() {
    const name = this.screenPersona.trim()
    if (!name || this.sending) return
    this.sending = true
    try {
      // A name that is a persona already is linked, not made twice.
      let p = this.personaFor(name)
      const made = !p
      if (!p) {
        p = await createPersona({ name })
        this.putPersona(p)
      }
      this.screenPersona = ''
      this.screenPersonaOpen = false
      if (!this.screen?.audience.some((a) => personaNamed(a, [p]))) await this.addPersonaToScreen(p)
      this.flash(made ? `${p.name} is a persona now, for this screen` : `For ${p.name} too`)
    } catch (err) {
      this.flash(errorText(err))
    } finally {
      this.sending = false
    }
  },
  async removeFromScreen(name: string) {
    const s = this.screen
    if (!s) return
    await this.saveScreen('audience', s.audience.filter((a) => a !== name).join(', '))
  },
  async answerPersonaQuestion(q: Question, text: string) {
    await this.sendPersonaReply({ q, text })
  },
  async sendPersonaReply(answer?: { q: Question; text: string }) {
    const p = this.persona
    const text = (answer ? answer.text : this.personaReply).trim()
    if (!p || !text || this.sending) return
    this.sending = true
    this.personaStatus = 'Saving...'
    try {
      const target = answer && this.replyQuestion(p.body, { entry: answer.q.entry, index: answer.q.index })
      if (answer && !target) return
      this.putPersona(await updatePersona(p.id, { body: target ? appendAnswer(p.body, target, text, today()) : appendEntry(p.body, 'you', text, today()) }))
      if (!answer) this.personaReply = ''
      this.personaStatus = ''
    } catch (err) {
      this.personaStatus = `Not saved: ${errorText(err)}`
    } finally {
      this.sending = false
    }
  },
  // Status: everything a good project has, done or not.
  get projectStatus(): ProjectStatus {
    return buildStatus({
      foundations: this.readiness?.foundations ?? [],
      screens: this.screens.filter((s) => !this.hiddenIds.has(s.id)),
      stories: this.stories,
      purpose: String(this.project.purpose ?? '').trim(),
      blocking: this.blockingCount,
      questions: this.questionIds.length,
      otherGaps: this.openGaps.length - this.blockingCount,
    })
  },
  /** The status row whose details are open. */
  statusRow: null as string | null,
  /** The kind of work left whose items are shown (decide, build, setup). */
  statusKind: null as string | null,
  /** Whether the full list, done or not, is shown under What's left. */
  statusAll: false,
  /** What each kind of work left asks of the person, in words. */
  statusKinds: {
    decide: { name: 'Decide', what: 'Questions your agent asked and gaps /readiness found. You answer them, in a line or by picking an option. No code.', action: 'Answer them' },
    build: { name: 'Build or confirm', what: 'Screens whose stories are not marked done. Many are probably built already and just not checked against the code; the rest need building. Let your agent check them first, then build what is missing.', action: 'Copy prompt' },
    setup: { name: 'Set up the project', what: 'What a well-run project has: a README, code standards, design tokens, tools for your agent. Your agent can add each one: copy its prompt into your agent in the product.', action: '' },
  } as Record<string, { name: string; what: string; action: string }>,
  /** The kind's main action: answer in the Inbox, or copy the check-the-stories instruction. */
  statusKindAction(kind: { key: string; rows: StatusRow[] }) {
    if (kind.key === 'decide') return this.inbox.length ? this.enterFocus() : this.showGaps()
    if (kind.key === 'build') {
      const lines = kind.rows.map((r) => `- ${r.title} (${r.open?.id ?? ''})${r.openStories?.length ? `: ${r.openStories.join(', ')}` : ''}`)
      return this.showPrompt(
        'Check these screens against the code',
        [
          'Check these screens and their stories in .grndwrk/stories/ against the code.',
          'For each story, go through its acceptance criteria: tick each one the code meets (- [x]) and leave the rest open (- [ ]); turn a plain - criterion into a checkbox. Set status: done when all are met, partial when some are, and fill applies_to with the routes or files.',
          'Do not build anything yet. End with a short list of what is left to build, screen by screen, so I can pick what to do first.',
          '',
          ...lines,
        ].join('\n'),
      )
    }
  },
  /** The row's own action: answer in Focus, open the screen, or write the purpose. */
  openStatusRow(row: StatusRow) {
    if (row.open?.kind === 'focus') return this.inbox.length ? this.enterFocus() : this.showGaps()
    if (row.open?.kind === 'screen' && row.open.id) {
      this.selectScreen(row.open.id)
      return this.setView('sitemap')
    }
    if (row.open?.kind === 'purpose') {
      this.statusRow = row.key
      focusWhenVisible('status-purpose')
    }
  },
  async copyDraft(name: string) {
    try {
      const text = await fetchDraft(name)
      if (text) await this.copyText(text)
      else this.flash(`No draft ${name} in .grndwrk/outputs/drafts/`)
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Open a story under Deliverables. */
  openStory(id: string) {
    this.setDeliverablesTab('stories')
    this.openStoryId = id
    this.setView('deliverables')
  },
  get surveyHtml(): string {
    return linkIds(md(stripFrontmatter(this.survey ?? '')))
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
    store('grndwrk.deliverablesTab', tab)
  },
  async copyStarter() {
    if (!this.starter) return
    try {
      await navigator.clipboard.writeText(this.starter)
      this.copied = true
      setTimeout(() => (this.copied = false), 2000)
    } catch {
      this.flash('The browser did not allow copying. Open .grndwrk/outputs/CLAUDE.starter.md instead.')
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
    if (source === 'inferred') return 'A guess. Check the thread.'
    if (source === 'app') {
      const from = typeof node?.extra?.from === 'string' ? node.extra.from : ''
      return from ? `Commented in the running product by ${from}, through the relay` : 'Commented in the running product'
    }
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
  /** A prompt for Claude, shown in full before it is copied; it can be changed there first. */
  prompt: null as { title: string; text: string } | null,
  showPrompt(title: string, text: string) {
    if (!text) return
    this.prompt = { title, text }
    focusWhenVisible('prompt-text')
  },
  async copyPrompt() {
    if (!this.prompt) return
    await this.copyText(this.prompt.text)
    this.prompt = null
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
    return cached('openGaps', () => {
      const order = { blocking: 0, important: 1, nice: 2 }
      return (this.readiness?.gaps ?? []).filter((g) => !g.answered_by).sort((a, b) => order[a.severity] - order[b.severity])
    })
  },
  get waitingGaps(): Gap[] {
    return (this.readiness?.gaps ?? []).filter((g) => g.answered_by && !g.enough)
  },
  /** Gaps the person accepted as they are. Closed for good. */
  get acceptedGaps(): Gap[] {
    return (this.readiness?.gaps ?? []).filter((g) => g.enough)
  },

  // The kickoff: steps signed off by the person, different for a new idea and
  // for a project that has code. Files only inform.
  /** new or existing, from project.md. Empty when nobody said yet. */
  get start(): 'new' | 'existing' | '' {
    const v = this.project.start
    return v === 'new' || v === 'existing' ? v : ''
  },
  /** True for a project that has code: said so, or /survey found code before anyone said. */
  get existingProject(): boolean {
    if (this.start) return this.start === 'existing'
    return Object.values(this.nodes).some((n) => typeof n.extra?.source === 'string' && n.extra.source !== 'app')
  },
  async setStart(start: 'new' | 'existing') {
    try {
      this.project = await saveProjectFields({ start })
      this.kickoffOpen = null
      this.flash(start === 'existing' ? 'An existing project. Start with /survey and /sitemap.' : 'A new project. Start with the purpose.')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async savePurpose(text: string) {
    const purpose = text.trim()
    if (purpose === String(this.project.purpose ?? '').trim()) return
    try {
      this.project = await saveProjectFields({ purpose })
      this.flash('Purpose saved')
    } catch (err) {
      this.flash(errorText(err))
    }
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
    const waiting = this.inbox.length + this.openGaps.length
    const brief = this.briefWritten
    const reportStale = !!report && !!this.mapChanged && this.mapChanged > report.checked
    const briefStale = !!brief && !!report && report.checked > brief
    const purpose = String(this.project.purpose ?? '').trim()
    const stories = `${this.stories.length} ${this.stories.length === 1 ? 'story' : 'stories'}`
    const answer: KickoffStepView = {
      key: 'answer',
      name: 'Answer',
      done: signed.answer ?? '',
      status: waiting ? `${waiting} waiting on you` + (this.blockingCount ? `, ${this.blockingCount} blocking` : '') : 'Nothing waiting on you.',
      next: waiting ? `${this.inbox.length ? 'Answer the questions in the Inbox. ' : ''}${this.openGaps.length ? 'Gaps are dashed cards on the map; "Enough for now" is a fine answer.' : ''}`.trim() : this.waitingGaps.length ? 'Run /readiness to check your answers.' : 'Move on, or run /challenge for a few sharp questions.',
      stale: waiting > 0,
    }

    if (this.existingProject) {
      const screens = this.screens.length
      return [
        {
          key: 'map',
          name: 'Survey',
          done: signed.map ?? '',
          status: fromCode || screens
            ? `${fromCode} ${fromCode === 1 ? 'thought' : 'thoughts'} found in the project, ${screens} ${screens === 1 ? 'screen' : 'screens'} in the sitemap`
            : 'Nothing read from the project yet.',
          next: !fromCode
            ? 'Run /survey in your agent. It reads the code, docs and history into the map.'
            : !screens
              ? 'Run /sitemap in your agent. It writes every screen: what it is for, who it is for, what they do there.'
              : this.survey
                ? `/survey found ${this.surveyFindings || 'some'} things worth knowing. Read them under Deliverables, State of the project.`
                : 'Check the sitemap and the map, and correct what your agent guessed.',
          stale: !fromCode || !screens,
        },
        {
          key: 'check',
          name: 'Foundations',
          done: signed.check ?? '',
          status: report ? `Checked ${report.checked}` + (reportStale ? '. The map changed since.' : '') : 'Not checked yet.',
          next: 'Run /readiness in your agent. It checks what the project has and lacks: purpose, CLAUDE.md, docs, design philosophy, design tokens.',
          stale: !report || reportStale,
        },
        answer,
        {
          key: 'brief',
          name: 'Plan',
          done: signed.brief ?? '',
          status: brief ? `Brief written ${brief}, ${stories}` + (briefStale ? '. Checked again since.' : '') : `${stories}, no brief yet.`,
          next: 'Run /brief in your agent: what is built, what comes next, and stories for it.',
          stale: !brief || briefStale,
        },
        {
          key: 'build',
          name: 'Build',
          done: signed.build ?? '',
          status: signed.build ? `Kickoff done on ${signed.build}.` : 'Hand the plan to the product.',
          next: 'Copy the "Working with stories" rules into the CLAUDE.md the project already has, then build against the stories.',
          stale: false,
        },
      ]
    }

    return [
      {
        key: 'purpose',
        name: 'Purpose',
        done: signed.purpose ?? '',
        status: purpose || 'No purpose written yet.',
        next: 'Say it in one line: what it is, and who it is for.',
        stale: !purpose,
      },
      {
        key: 'map',
        name: 'Map',
        done: signed.map ?? '',
        status: nodes.length ? `${nodes.length} ${nodes.length === 1 ? 'thought' : 'thoughts'}, ${settled} settled` : 'Nothing in the map yet.',
        next: 'Add what is on your mind. Move on when the main flows and screens are in.',
        stale: !nodes.length,
      },
      {
        key: 'check',
        name: 'Check',
        done: signed.check ?? '',
        status: report ? `${this.verdictLabel}, checked ${report.checked}` + (reportStale ? '. The map changed since.' : '') : 'Not checked yet.',
        next: 'Run /readiness in your agent. It says what is missing and suggests answers.',
        stale: !report || reportStale,
      },
      answer,
      {
        key: 'brief',
        name: 'Brief',
        done: signed.brief ?? '',
        status: brief ? `Written ${brief}, ${stories}` + (briefStale ? '. Checked again since.' : '') : 'Not written yet.',
        next: 'Run /brief in your agent: the brief, the stories, the screens, and a CLAUDE.md to start with.',
        stale: !brief || briefStale,
      },
      {
        key: 'build',
        name: 'Build',
        done: signed.build ?? '',
        status: signed.build ? `Kickoff done on ${signed.build}.` : 'Hand the brief to the product.',
        next: 'Copy CLAUDE.starter.md into the product as its CLAUDE.md, then build against the stories.',
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

  // The Inbox: Claude's questions, each answered in place, with a way to see it on the map.
  /**
   * Every open question from Claude: on thoughts, guesses from /survey to
   * confirm, and on screens. Gaps are not here; they are dashed cards on the
   * map. Working on one part shows that part's only.
   */
  get inbox(): InboxItem[] {
    return cached('inbox', () => {
      const nodes = groupForList(Object.values(this.nodes).filter((n) => this.inScope(n) && !isFixed(n) && !this.hiddenIds.has(screenOf(n, this.screens))), '').flatMap((g) => g.nodes)
      const guess = (n: GNode) => n.extra?.source === 'inferred' && n.status === 'open' && !splitBody(n.body).entries.some((e) => e.who === 'you')
      // Every open question is its own item: Claude may ask several things about one thought.
      const asked = (body: string) => questions(body).filter((q) => q.open)
      const entries = (body: string) => splitBody(body).entries
      const items = (kind: InboxItem['kind'], id: string, about: string, where: string, body: string): InboxItem[] => {
        const open = asked(body)
        // A guess without a question is still one thing to confirm.
        if (!open.length) return kind === 'guess' ? [{ key: `node:${id}`, kind, id, question: '', options: [], text: '', about, where, date: '', entry: -1, index: 0, of: 1 }] : []
        return open.map((q, n) => ({
          key: `${kind === 'screen' || kind === 'persona' ? kind : 'node'}:${id}:${q.entry}:${q.index}`,
          kind, id, about, where,
          question: this.entryWords(q.question), options: q.options, text: entries(body)[q.entry]?.text ?? '', date: q.date,
          entry: q.entry, index: q.index, of: open.length, position: n + 1,
        }))
      }
      const screens = screenTree(this.screens).filter(({ screen }) => !screen.error && !this.hiddenIds.has(screen.id) && (!this.scope || screen.id === this.scope))
      return [
        ...nodes.filter((n) => !guess(n)).flatMap((n) => items('question', n.id, n.title, n.topic, n.body)),
        ...screens.flatMap(({ screen }) => items('screen', screen.id, screen.title, this.screenPath(screen), screen.body)),
        ...(this.scope ? [] : this.personas.filter((p) => !p.error).flatMap((p) => items('persona', p.id, p.name, 'Personas', p.body))),
        ...nodes.filter(guess).flatMap((n) => items('guess', n.id, n.title, n.topic, n.body)),
      ]
    })
  },
  /**
   * Everything about what a question is on, to read in the Inbox without
   * leaving it: where it sits, its notes, the conversation before the
   * question, and for a screen its purpose, who it is for and what they do.
   */
  inboxDetail(item: InboxItem): { facts: string[]; notesHtml: string; earlier: Entry[]; links: { id: string; title: string }[]; purpose: string; audience: string[]; tasks: string[] } {
    const empty = { facts: [], notesHtml: '', earlier: [], links: [], purpose: '', audience: [], tasks: [] }
    if (item.kind === 'persona') {
      const p = this.personas.find((x) => x.id === item.id)
      if (!p) return empty
      const { notes, entries } = splitBody(p.body)
      return { ...empty, facts: [p.source === 'inferred' ? 'a guess' : p.source, ...this.screensFor(p).slice(0, 4).map((s) => `on ${s.title}`)].filter(Boolean) as string[], notesHtml: notes.trim() ? md(notes) : '', earlier: entries.filter((e) => !e.open), purpose: p.summary }
    }
    if (item.kind === 'screen') {
      const s = this.screens.find((x) => x.id === item.id)
      if (!s) return empty
      const { notes, entries } = splitBody(s.body)
      return { ...empty, facts: [s.status, this.screenPath(s) && `under ${this.screenPath(s)}`].filter(Boolean) as string[], notesHtml: notes.trim() ? md(notes) : '', earlier: entries.filter((e) => !e.open), purpose: s.purpose, audience: s.audience, tasks: s.tasks }
    }
    const n = this.nodes[item.id]
    if (!n) return empty
    const { notes, entries } = splitBody(n.body)
    const screen = this.screens.find((s) => s.id === n.extra?.screen)
    return {
      ...empty,
      facts: [n.type, n.status, n.page && `page ${n.page}`, n.topic && `topic ${n.topic}`, screen && `screen ${screen.title}`].filter(Boolean) as string[],
      notesHtml: notes.trim() ? md(notes) : '',
      earlier: entries.filter((e) => !e.open),
      links: n.links.filter((id) => this.nodes[id]).map((id) => ({ id, title: this.nodes[id].title })),
    }
  },
  /** The free notes on a thought, without its thread or pictures, for context. */
  notesOf(id: string): string {
    const n = this.nodes[id]
    return n ? splitBody(n.body).notes.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() : ''
  },
  /** Where a screen sits in the tree: Home › Booking. */
  screenPath(screen: Screen): string {
    const byId = new Map(this.screens.map((s) => [s.id, s]))
    const path: string[] = []
    const seen = new Set<string>()
    for (let p = byId.get(screen.parent); p && !seen.has(p.id); p = byId.get(p.parent)) {
      seen.add(p.id)
      path.unshift(p.title)
    }
    return path.join(' › ')
  },
  /** What to do once Claude has nothing to ask. */
  get inboxNextStep(): string {
    if (this.openGaps.length) return `${this.openGaps.length} ${this.openGaps.length === 1 ? 'gap waits' : 'gaps wait'} on the map, as dashed cards.`
    if (!this.readiness?.report) return 'Run /readiness in your agent to see what is missing.'
    if (this.waitingGaps.length) return `Run /readiness in your agent to check your ${this.waitingGaps.length === 1 ? 'answer' : 'answers'}.`
    if (!this.brief) return 'Run /brief in your agent to write the brief and the first stories.'
    return 'Run /challenge for a few sharp questions, or keep adding thoughts in the map.'
  },
  enterFocus() {
    this.select(null)
    this.setView('focus')
  },
  /** Leave the Inbox for the place the question is about: the card on the map, or the screen. */
  viewInMap(item: InboxItem) {
    if (item.kind === 'screen') {
      this.selectScreen(item.id)
      return this.setView('sitemap')
    }
    if (item.kind === 'persona') return this.openPersona(item.id)
    this.goToNode(item.id)
  },
  /** Show the first open gap on the map, the blocking ones first. */
  showGaps() {
    const gap = [...this.openGaps].sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking'))[0]
    if (gap) this.showGapInMap(gap.id)
    else this.setView('map')
  },
  /** Answer a question in the Inbox: a **You** entry in its thread. It leaves the Inbox once answered. */
  async answerInbox(item: InboxItem, given?: string) {
    const text = (given ?? this.inboxDrafts[item.key] ?? '').trim()
    if (!text || this.inboxSending) return
    this.inboxSending = item.key
    try {
      // The answer to this question only, quoting it when others wait on the same thought.
      const answer = (body: string) => {
        const q = questions(body).find((x) => x.entry === item.entry && x.index === item.index && x.open)
        return q ? appendAnswer(body, q, text, today()) : appendEntry(body, 'you', text, today())
      }
      if (item.kind === 'screen') {
        const screen = this.screens.find((s) => s.id === item.id)
        if (!screen) return
        this.putScreen(await updateScreen(screen.id, { body: answer(screen.body) }))
      } else if (item.kind === 'persona') {
        const p = this.personas.find((x) => x.id === item.id)
        if (!p) return
        this.putPersona(await updatePersona(p.id, { body: answer(p.body) }))
      } else {
        const n = this.nodes[item.id]
        if (!n) return
        this.upsert(await updateNode(n.id, { body: answer(n.body) }))
      }
      delete this.inboxDrafts[item.key]
      this.flash(`Answered. Your agent reads it on the next ${item.kind === 'screen' ? '/sitemap' : item.kind === 'persona' ? '/personas' : 'command'} run.`)
    } catch (err) {
      this.flash(errorText(err))
    } finally {
      this.inboxSending = ''
    }
  },
  /** Start an answer to the open gap from one of its suggestions. It can be edited before sending. */
  pickOption(text: string) {
    this.gapAnswer = text
    focusWhenVisible('gap-answer')
  },
  /** A guess from /survey is right: settle it, and answer its question if one is open. */
  async confirmGuess(id: string) {
    const n = this.nodes[id]
    if (!n) return
    // Each open question is answered on its own: a reply without a quote would be a remark.
    const body = questions(n.body)
      .filter((q) => q.open)
      .reduce((b, q) => appendAnswer(b, q, 'Yes, that is right.', today()), n.body)
    try {
      this.upsert(await updateNode(n.id, { status: 'settled', body }))
      this.flash('Confirmed and settled.')
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
    store('grndwrk.view', view)
    if (view === 'map') revealSelection()
    if (view === 'docs') void this.loadDocs()
  },
  // Documents: what steers your agent in the product, with what the last check found in each, readable and editable here.
  docs: [] as Doc[],
  docPath: readStored<string>('grndwrk.docPath', ''),
  doc: null as { path: string; text: string; exists: boolean; draft?: string } | null,
  async loadDocs() {
    this.docs = await fetchDocs()
    const keep = this.docs.find((d) => d.path === this.docPath) ?? this.docs[0]
    if (keep && (!this.doc || this.doc.path !== keep.path)) await this.openDoc(keep.path)
  },
  get openDocInfo(): Doc | null {
    return this.docs.find((d) => d.path === this.docPath) ?? null
  },
  /** The worst a check said about a document: missing, partly, or nothing to add. */
  docStatus(d: Doc): 'missing' | 'partly' | 'ok' | '' {
    if (d.blocked || !d.exists) return 'missing'
    const live = d.findings.filter((f) => f.status !== 'done')
    if (live.some((f) => f.status === 'missing')) return 'missing'
    if (live.length) return 'partly'
    return d.findings.length ? 'ok' : ''
  },
  /** What the checks found that is not in any document: things to write that have no file yet. */
  get docsUnplaced(): Foundation[] {
    const placed = new Set(this.docs.flatMap((d) => d.findings.map((f) => f.id)))
    return (this.readiness?.foundations ?? []).filter((f: Foundation) => f.status !== 'done' && !placed.has(f.id))
  },
  async openDoc(path: string) {
    this.docPath = path
    store('grndwrk.docPath', path)
    try {
      this.doc = await fetchDoc(path)
    } catch (err) {
      this.doc = null
      this.flash(errorText(err))
    }
  },
  async openDocEditor() {
    if (!this.doc?.exists) return
    try {
      await openDocInEditor(this.doc.path)
      this.flash(`Opened ${this.doc.path} in your editor`)
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** The open document's headings, to comment on one. */
  get docHeadings(): string[] {
    const t = this.doc ? (this.doc.exists ? this.doc.text : (this.doc.draft ?? '')) : ''
    return t.split('\n').filter((l) => /^#{1,4}\s+\S/.test(l)).map((l) => l.replace(/^#+\s+/, '').trim()).slice(0, 80)
  },
  /** Comments on documents: thoughts about one document, or one of its sections, for Claude to act on. */
  docSection: '',
  docComment: '',
  get docComments(): GNode[] {
    const path = this.docPath
    return Object.values(this.nodes).filter((n) => n.extra?.doc === path && n.status !== 'settled')
  },
  async commentOnDoc() {
    const text = this.docComment.trim()
    const d = this.openDocInfo
    if (!text || !d) return
    const first = text.split('\n')[0]
    try {
      const node = await createNode({
        title: first.length > 140 ? first.slice(0, 137) + '...' : first,
        type: 'idea',
        topic: 'documents',
        body: `About ${d.path}${this.docSection ? `, the section "${this.docSection}"` : ''}.${text !== first ? `\n\n${text}` : ''}\n`,
        doc: d.path,
        ...(this.docSection ? { doc_section: this.docSection } : {}),
      } as never)
      this.upsert(node)
      this.docComment = ''
      this.docSection = ''
      this.flash('Comment added. Copy prompt includes it.')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  async resolveDocComment(id: string) {
    try {
      this.upsert(await updateNode(id, { status: 'settled' }))
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** What to give your agent in the product for this document: what the check suggests, your comments, or to write it from the draft. */
  docPrompt(): string {
    const d = this.openDocInfo
    // A link or a folder named as a document is never one to write: writing it would follow the link.
    if (!d || d.blocked) return ''
    const comments = this.docComments.map((n) => `- ${n.extra?.doc_section ? `In the "${n.extra.doc_section}" section: ` : ''}${n.title}${n.body.split('\n').slice(2).join(' ').trim() ? `. ${n.body.split('\n').slice(2).join(' ').trim()}` : ''}`)
    const withComments = (lines: string[]) => (comments.length ? [...lines, '', 'My comments on it:', ...comments, '', 'When a comment is done, settle its thought in .grndwrk/nodes/ (status: settled).'] : lines)
    const live = d.findings.filter((f) => f.status !== 'done')
    if (!d.exists) {
      return withComments([
        `Create ${d.path} in this project${d.draft ? `, starting from the draft in .grndwrk/outputs/drafts/${d.draft}` : ''}.`,
        ...live.flatMap((f) => [f.suggestion, ...f.missing.map((m) => `- ${m}`)]).filter(Boolean),
        d.draft ? 'Answer the questions the draft leaves open with me first; do not guess them.' : '',
        'Link it from CLAUDE.md or AGENTS.md if your agent should read it.',
      ].filter(Boolean)).join('\n')
    }
    return withComments([
      `Update ${d.path}:`,
      ...live.map((f) => `- ${f.section ? `In the "${f.section.replace(/-/g, ' ')}" section: ` : ''}${f.missing.join('; ')}${f.suggestion ? `. ${f.suggestion}` : ''}`),
      'Change only what these points ask for, and keep the rest as it is.',
    ]).join('\n')
  },
  /** The rendered document, with the sections a check found something about marked. */
  docHtml(): string {
    const d = this.doc
    if (!d) return ''
    return md(d.exists ? d.text : (d.draft ?? ''))
  },
  /** Mark the headings a finding is about, after the document is drawn. Only text is set, never markup. */
  markDocSections(el: HTMLElement) {
    const info = this.openDocInfo
    const live = (info?.findings ?? []).filter((f) => f.section && f.status !== 'done')
    const slug = (t: string) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')
    el.querySelectorAll('.doc-flag-note').forEach((n) => n.remove())
    el.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      h.classList.remove('doc-flag')
      const hits = live.filter((f) => f.section === slug(h.textContent ?? ''))
      if (!hits.length) return
      h.classList.add('doc-flag')
      const note = document.createElement('div')
      note.className = 'doc-flag-note'
      note.textContent = hits.map((f) => `${f.title}: ${f.missing.join('; ') || f.status}`).join(' · ')
      h.after(note)
    })
  },
  /**
   * A comment pointed out on the phone, to be written here: open it with the
   * title selected, so typing replaces the placeholder.
   */
  writeComment(id: string, reply = false) {
    if (!this.nodes[id]) return
    this.goToNode(id)
    window.focus()
    // Rejected on the phone: what is still wrong goes in the thread, below the reject.
    if (reply) return focusWhenVisible('reply')
    this.selectTitle = true
    this.editingTitle = true
  },
  /** Open a thought in the map, from any view. */
  goToNode(id: string) {
    const node = this.nodes[id]
    if (!node) return
    if (!(this.scopeScreen && this.inScope(node)) && !this.onAll && !samePage(pageOf(node, this.pageNames), this.currentPage)) this.showPage(pageOf(node, this.pageNames))
    if (this.view !== 'map') this.setView('map')
    // A fixed comment, or a thought the feedback filter hides: show what it belongs with.
    if (!this.visibleNodes.includes(node)) {
      const p = progressOfNode(node)
      this.setProgressFilter(p === 'done' || p === 'later' ? p : '')
    }
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
    return cached('board', () => {
      // Inside one part, its thoughts group by topic: the part's areas and features.
      const groupBy = this.scopeScreen ? 'topic' : this.groupBy
      return buildBoard(this.visibleNodes, this.visibleGaps, this.visibleStories, { groupBy, cardGroup: this.cardGroup, screens: this.viewScreens, scope: this.scopeScreen })
    })
  },
  get outline(): OutlineSection[] {
    return cached('outline', () => {
      return buildOutline(this.board)
    })
  },
  /** How cards are grouped inside each column. Kept in the browser. */
  cardGroup: readStored<CardGroup>('grndwrk.cardGroup', 'level'),
  setCardGroup(group: CardGroup) {
    this.cardGroup = group
    store('grndwrk.cardGroup', group)
  },
  /** The feature a new section is being named for, as "<screen id>", and the one being renamed, as "<screen id>:<feature>". */
  addingFeature: '',
  /** The section a dragged card is over, with dropCell for its column. */
  dropSection: '',
  renamingFeature: '',
  /** Add a feature to a screen: an empty section to drop cards in. */
  async addFeature(screenId: string, name: string) {
    this.addingFeature = ''
    const s = this.screens.find((x) => x.id === screenId)
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!s || !clean) return
    if (s.features.some((f) => f.toLowerCase() === clean.toLowerCase())) return this.flash(`${s.title} already has ${clean}`)
    try {
      this.putScreen(await updateScreen(s.id, { features: [...s.features, clean] }))
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Rename a feature on its screen and every thought that names it. An empty name removes it; its thoughts keep no feature. */
  async renameFeature(screenId: string, from: string, to: string) {
    this.renamingFeature = ''
    const s = this.screens.find((x) => x.id === screenId)
    const name = to.replace(/\s+/g, ' ').trim()
    if (!s || name === from) return
    const same = (a: string) => a.toLowerCase() === from.toLowerCase()
    try {
      const listed = s.features.some(same) || !name ? s.features : [...s.features, from]
      const features = name ? listed.map((f) => (same(f) ? name : f)) : listed.filter((f) => !same(f))
      this.putScreen(await updateScreen(s.id, { features: features.filter((f, i) => features.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i) }))
      const mine = Object.values(this.nodes).filter((n) => screenOf(n, this.screens) === s.id && same(featureOf(n)))
      for (const n of mine) this.upsert(await updateNode(n.id, { feature: name }))
      this.flash(name ? `Renamed to ${name}` : `Removed ${from}; its thoughts have no feature now`)
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  /** Set the open thought's feature. A new one is added to its screen's features. */
  async saveFeature(value: string) {
    const n = this.selected
    if (!n) return
    const name = value.replace(/\s+/g, ' ').trim()
    if (name === featureOf(n)) return
    try {
      this.upsert(await updateNode(n.id, { feature: name }))
      const s = this.screens.find((x) => x.id === screenOf(n, this.screens))
      if (s && name && !s.features.some((f) => f.toLowerCase() === name.toLowerCase())) this.putScreen(await updateScreen(s.id, { features: [...s.features, name] }))
      this.flash('Saved')
    } catch (err) {
      this.flash(errorText(err))
    }
  },
  featureOf,
  /** The screen a thought is about, for the panel. */
  screenOf(n: GNode | null): string {
    return n ? screenOf(n, this.screens) : ''
  },
  /** A screen's features with how many thoughts each has, listed ones first, then any a thought names. */
  featuresOf(screen: Screen): { name: string; count: number }[] {
    const mine = Object.values(this.nodes).filter((n) => screenOf(n, this.screens) === screen.id)
    const names = [...screen.features]
    for (const n of mine) if (featureOf(n) && !names.some((f) => f.toLowerCase() === featureOf(n).toLowerCase())) names.push(featureOf(n))
    return names.map((name) => ({ name, count: mine.filter((n) => featureOf(n).toLowerCase() === name.toLowerCase()).length }))
  },
  /** Open a screen's part of the map with its thoughts grouped by feature. */
  workOnFeatures(id: string) {
    this.setCardGroup('feature')
    this.workOn(id)
  },
  /** The features of the open thought's screen, for its Feature field. */
  get selectedFeatures(): string[] {
    const n = this.selected
    const s = n ? this.screens.find((x) => x.id === screenOf(n, this.screens)) : null
    return s?.features ?? []
  },
  setGroupBy(groupBy: GroupBy) {
    this.groupBy = groupBy
    store('grndwrk.groupBy', groupBy)
    revealSelection()
  },
  firstLine,
  setMapLayout(layout: MapLayout) {
    this.mapLayout = layout
    store('grndwrk.mapLayout', layout)
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
    if (id.startsWith('gap:')) return this.selectGap(id.slice(4))
    if (id.startsWith('story:')) return this.selectStory(id.slice(6))
    if (this.mode === 'link' && this.selectedId && id !== this.selectedId) void this.toggleLink(id)
    else this.select(id)
  },
  clickBackground() {
    if (this.mode !== 'link') this.select(null)
  },
  /** Linked to the open card, so it lights up on the board. */
  isLinked(id: string): boolean {
    return !!this.selected?.links.includes(id)
  },
  /** Kept for the templates: nothing is dimmed now that the Inbox is a page of its own. */
  dimmed(_id: string): boolean {
    return false
  },
  /**
   * Dropping a card in another column moves it to that screen (or General),
   * or that topic. Dropped on another card, it also takes that card's level.
   */
  async moveCard(id: string, column: string, altitude?: number, section?: string) {
    const node = this.nodes[id]
    this.dragId = null
    this.dropCell = ''
    if (!node || node.error) return
    const board = this.board
    const col = board.columns.find((c) => c.key === column)
    const changes: NodeInput = {}
    let where = ''
    // Dropped in a section: it takes that feature, topic or type, like a card moved between groups in Notion.
    const sec = section !== undefined ? col?.sections.find((x) => x.key === section) : undefined
    if (sec && board.cardGroup === 'feature' && sec.key !== featureOf(node).toLowerCase()) {
      changes.feature = sec.key ? sec.name : ''
      where = sec.key ? `to ${sec.name}` : 'to no feature'
    } else if (sec && board.cardGroup === 'topic' && topicKey(node.topic) !== topicKey(sec.name) && board.groupBy !== 'topic') {
      changes.topic = sec.key ? sec.name : ''
      where = `to ${changes.topic || 'no topic'}`
    } else if (sec && board.cardGroup === 'type' && sec.key && node.type !== sec.key) {
      changes.type = sec.key as NodeType
      where = `to ${sec.key}`
    }
    if (board.groupBy === 'page' && !this.scopeScreen) {
      const now = typeof node.extra?.screen === 'string' ? node.extra.screen : ''
      if (now !== column) {
        changes.screen = column
        // A feature belongs to its screen: on another screen, the card keeps one only when dropped in one of its sections.
        if (changes.feature === undefined && featureOf(node)) changes.feature = ''
        where = [where, `to ${col?.name ?? 'General'}`].filter(Boolean).join(', ')
      }
    } else if (topicKey(node.topic) !== column) {
      changes.topic = column && col ? col.name : ''
      where = `to ${changes.topic || 'no topic'}`
    }
    if (altitude !== undefined && node.altitude !== altitude) {
      changes.altitude = altitude
      where = [where, `to ${ALTITUDE_WORDS[altitude]}`].filter(Boolean).join(', ')
    }
    if (!Object.keys(changes).length) return
    try {
      this.upsert(await updateNode(id, changes))
      this.markFresh(id)
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

  /** What to focus on next, the most important first, without what was set aside. */
  get focusItems(): FocusItem[] {
    return (this.readiness?.focus ?? []).filter((f) => !f.later)
  },
  /** Focus items set aside with Not now. */
  get focusSetAside(): FocusItem[] {
    return (this.readiness?.focus ?? []).filter((f) => f.later)
  },
  /** Not now, or bring one back. */
  async focusLater(id: string, later: boolean) {
    try {
      this.readiness = await setFocusLater(id, later)
      this.flash(later ? 'Set aside. Bring it back under the Focus box.' : 'Back in the Focus box.')
    } catch (err) {
      this.flash(errorText(err))
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
      store('grndwrk.page', gap.page)
    }
    this.view = 'map'
    store('grndwrk.view', 'map')
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
      const node = await createNode({ title, topic: gap.topic ?? '', page: gap.page ?? '', altitude: gap.altitude ?? 3, links, body, answers: gap.id, ...(gap.screen ? { screen: gap.screen } : {}) })
      this.upsert(node)
      this.markFresh(node.id)
      if (closes) this.readiness = await markGapAnswered(gap.id, node.id)
      this.gapAnswer = ''
      this.flash(closes ? 'Marked as answered. /readiness decides if it closes.' : 'Added as a thought. The gap stays open.')
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
      this.flash('Some edits on the last card were not saved. grndwrk is offline.')
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
  /** What the Add bar adds: a thought, or a story. */
  captureKind: readStored<'thought' | 'story'>('grndwrk.captureKind', 'thought'),
  setCaptureKind(kind: 'thought' | 'story') {
    this.captureKind = kind
    store('grndwrk.captureKind', kind)
  },
  async submitCapture() {
    const parsed = parseCapture(this.capture)
    if (!parsed) return
    const raw = this.capture
    const linkTo = this.selected && !this.selected.error && this.captureLinked ? this.selected : null
    this.capture = ''

    // A story comes from a thought: the open one, or a new thought with the same words.
    if (this.captureKind === 'story') {
      try {
        let from = linkTo
        if (!from) {
          const page = this.onAll ? '' : this.currentPage
          from = await createNode({ title: parsed.title, type: 'feature', page, ...(this.scopeScreen ? { screen: this.scopeScreen.id } : {}) })
          this.upsert(from)
        }
        const st = await createStory({ title: parsed.title, from: [from.id] })
        this.putStory(st)
        this.selectStory(st.id)
        this.editStoryText()
        this.flash(linkTo ? `Story from "${linkTo.title}"` : 'Story added, with a thought it comes from')
      } catch (err) {
        if (!this.capture) this.capture = raw
        this.flash(errorText(err))
      }
      return
    }

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
      const screen = this.scopeScreen?.id ?? (typeof linkTo?.extra?.screen === 'string' ? linkTo.extra.screen : undefined)
      // And its feature, when it is about the same screen.
      const feature = linkTo && screen && linkTo.extra?.screen === screen ? featureOf(linkTo) : ''
      const node = await createNode({ ...parsed, links: linkTo ? [linkTo.id] : [], topic: linkTo?.topic ?? '', page, ...(screen ? { screen } : {}), ...(feature ? { feature } : {}) })
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
  async sendReply(answer?: { q: Question; text: string }) {
    const text = (answer ? answer.text : this.reply).trim()
    const id = this.selectedId
    if (!text || !id || this.sending) return
    // An answer quotes its question; the reply box writes a remark, which answers nothing.
    const target = answer && this.replyQuestion(this.draft.body, { entry: answer.q.entry, index: answer.q.index })
    if (answer && !target) return
    const body = target ? appendAnswer(this.draft.body, target, text, today()) : appendEntry(this.draft.body, 'you', text, today())
    this.sending = true
    this.replyStatus = 'Saving...'
    try {
      clearTimeout(timers.get('body'))
      timers.delete('body')
      const node = await updateNode(id, { body })
      pending.delete('body')
      if (!answer) replyDrafts.delete(id)
      if (this.selectedId === id) {
        this.draft.body = body
        if (!answer) this.reply = ''
      }
      this.replyStatus = ''
      this.upsert(node)
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
    if (!(this.scopeScreen && this.inScope(node)) && !this.onAll && !samePage(pageOf(node, this.pageNames), this.currentPage)) this.showPage(pageOf(node, this.pageNames))
    this.select(id)
  },

  showPage(page: string) {
    // Choosing a page goes back to the whole product.
    if (this.scope) {
      this.scope = null
      store('grndwrk.scope', null)
    }
    this.currentPage = page
    store('grndwrk.page', page)
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
    store('grndwrk.detailsMinimized', min)
  },

  isCollapsed(key: string): boolean {
    // While searching, every match shows.
    return !this.query && !!this.collapsed[key]
  },
  toggleGroup(key: string) {
    this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] }
    store('grndwrk.collapsed', this.collapsed)
  },

  // List and search
  /** `/`: show the list if it is collapsed and put the cursor in search. */
  openList() {
    this.setListOpen(true)
    this.searchOpen = true
    this.listIndex = 0
    focusWhenVisible('search')
  },
  setTheme(theme: Theme) {
    this.theme = theme
    store('grndwrk.theme', theme)
    applyTheme(theme)
  },
  setListOpen(open: boolean) {
    this.listOpen = open
    if (!open) this.query = ''
    store('grndwrk.listOpen', open)
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

/**
 * Markdown as HTML for x-html. Sanitized: files can hold text from anyone who
 * sent a comment, quoted by Claude into a report or a brief. Stricter than
 * DOMPurify's defaults: no styles, forms or embedded content (they can restyle
 * or cover the map, say hide a pairing request), no Alpine attributes (x-html
 * starts Alpine on what it inserts), and pictures only from grndwrk itself,
 * so rendering a file never tells another server that it was opened.
 */
export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE)
}

const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base', 'template', 'dialog'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'autofocus', 'tabindex', 'id', 'name'],
  ALLOW_DATA_ATTR: false,
}

/** A picture from this server: a relative path, or /files/ and /shots/. */
const LOCAL_SRC = /^(?:\.{0,2}\/)?(?:files|shots)\/[^:]*$|^\/(?:files|shots)\/[^:]*$/i

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Alpine's own attributes: x-data, x-init, :href, @click.
  if (/^(x-|:|@)/i.test(data.attrName)) data.keepAttr = false
})
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && !LOCAL_SRC.test(node.getAttribute('src') ?? '')) node.removeAttribute('src')
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    // A path starting with a backslash after the slash is read as '//host' by browsers: outside too.
    if (/^(https?:|[\/\\]{2})/i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    } else if (href && !/^(#|\/|\.)/.test(href)) node.removeAttribute('href')
  }
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const NODE_ID = /\b(n_[a-z0-9]{4,8})\b/g

/**
 * Node ids in rendered text, like (n_bz8p), become links to the thought.
 * Done on the parsed text nodes, never on the HTML as a string: a rewrite of
 * sanitized markup can turn an attribute's text into live markup again.
 */
function linkIds(html: string): string {
  if (!html.includes('n_')) return html
  const t = document.createElement('template')
  t.innerHTML = html
  const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!(n.parentElement?.closest('a, code, pre')) && NODE_ID.test((n as Text).data)) texts.push(n as Text)
    NODE_ID.lastIndex = 0
  }
  for (const text of texts) {
    const parts = text.data.split(NODE_ID)
    const frag = document.createDocumentFragment()
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) frag.append(part)
        return
      }
      const a = document.createElement('a')
      a.href = '#'
      a.className = 'node-link'
      a.dataset.node = part
      a.textContent = part
      frag.append(a)
    })
    text.replaceWith(frag)
  }
  return t.innerHTML
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '')
}

export type Theme = 'system' | 'light' | 'dark'

function readTheme(): Theme {
  const t = readStored<string>('grndwrk.theme', 'system')
  return t === 'light' || t === 'dark' ? t : 'system'
}

/** The colors follow the system (prefers-color-scheme) unless <html> has .light or .dark. */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/** A QR code as one SVG path in a square of its module count, drawn by the map: no markup from elsewhere. */
function qrPath(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
  return `${n}|${d}`
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
