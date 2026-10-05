import Alpine from 'alpinejs'
import type { Gap, GNode, NodeType, Readiness, Status, Story } from '../../src/shared/types'
import { NODE_TYPES, STATUSES } from '../../src/shared/types'
import { createNode, deleteNode, fetchOutput, fetchReadiness, fetchStories, markGapAnswered, savePages, updateNode, uploadImage } from './api'
import { mergePages, pageOf, samePage } from '../../src/shared/pages'
import { appendEntry, openQuestions, replaceNotes, splitBody, type Entry } from '../../src/shared/thread'
import { parseAreas, type Area } from '../../src/shared/report'
import { parseCapture, sameTitle } from './capture'
import { marked } from 'marked'
import { ALTITUDE_WORDS, displayName, topicColumns } from './layout'
import { TYPE_COLORS } from './palette'
import { flatten, groupForList, type ListGroup } from './list'

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

/** Called whenever the nodes change, so the scene can redraw. Set by main.ts. */
let onChange: () => void = () => {}
export function onNodesChange(fn: () => void) {
  onChange = fn
}

let fitHandler: () => void = () => {}
export function onFit(fn: () => void) {
  fitHandler = fn
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
  currentPage: readStored<string>('groundwork.page', ALL),
  addingPage: false,
  /** The list shows only topics that are thin or have missing pieces. */
  onlyAttention: false,
  reply: '',
  sending: false,
  readiness: null as Readiness | null,
  /** Which view the rail shows: the 3D map, readiness, or deliverables. */
  view: readStored<'map' | 'readiness' | 'deliverables'>('groundwork.view', 'map'),
  stories: [] as Story[],
  brief: null as string | null,
  starter: null as string | null,
  deliverablesTab: readStored<'brief' | 'stories' | 'starter'>('groundwork.deliverablesTab', 'brief'),
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
    onChange()
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
    return marked.parse(stripFrontmatter(this.brief ?? ''), { async: false }) as string
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
      const [stories, brief, starter] = await Promise.all([fetchStories(), fetchOutput('brief.md'), fetchOutput('CLAUDE.starter.md')])
      this.stories = stories
      this.brief = brief
      this.starter = starter
      onChange()
    } catch {
      // Offline: the next reconnect loads them.
    }
  },
  setDeliverablesTab(tab: 'brief' | 'stories' | 'starter') {
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
      this.flash(`Copied ${text}`)
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
  /** "5 of 9 in place": found counts as one, partly as half. */
  get designScore(): string {
    const d = this.readiness?.design ?? []
    const found = d.filter((c) => c.status === 'found').length
    const partly = d.filter((c) => c.status === 'partly').length
    return `${found} of ${d.length} in place` + (partly ? `, ${partly} partly` : '')
  },
  get designPercent(): number {
    const d = this.readiness?.design ?? []
    if (!d.length) return 0
    const points = d.reduce((sum, c) => sum + (c.status === 'found' ? 1 : c.status === 'partly' ? 0.5 : 0), 0)
    return Math.round((points / d.length) * 100)
  },
  get areas(): Area[] {
    return parseAreas(this.readiness?.report?.body ?? '')
  },
  get openGaps(): Gap[] {
    const order = { blocking: 0, important: 1, nice: 2 }
    return (this.readiness?.gaps ?? []).filter((g) => !g.answered_by).sort((a, b) => order[a.severity] - order[b.severity])
  },
  get waitingGaps(): Gap[] {
    return (this.readiness?.gaps ?? []).filter((g) => g.answered_by)
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
  setView(view: 'map' | 'readiness' | 'deliverables') {
    this.view = view
    store('groundwork.view', view)
    onChange()
    if (view === 'map') setTimeout(fitHandler, 80)
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
    const left = 64 + (this.listOpen && wide ? 320 : 0)
    const right = this.detailsVisible ? 360 : 0
    return { left: `${left}px`, right: `${right}px` }
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
    onChange()
  },
  upsert(node: GNode) {
    this.nodes[node.id] = node
    if (node.id === this.selectedId) this.syncDraft()
    onChange()
  },
  removeLocal(id: string) {
    if (!this.nodes[id]) return
    delete this.nodes[id]
    if (id === this.selectedId) {
      this.select(null)
      if (!deleting.has(id)) this.flash('That node was deleted on disk')
    }
    onChange()
  },

  async loadReadiness() {
    try {
      this.readiness = await fetchReadiness()
      onChange()
    } catch {
      // Offline: the next reconnect loads it.
    }
  },
  /** Close whatever the right panel shows. */
  closePanel() {
    this.select(null)
    this.reportOpen = false
    onChange()
  },
  openReport() {
    this.select(null)
    this.reportOpen = true
    this.setDetailsMinimized(false)
  },
  /** Go to a gap in the map: its page, the map view, and the camera on its ghost. */
  showGapInMap(id: string) {
    const gap = this.readiness?.gaps.find((g) => g.id === id)
    if (!gap) return
    if (gap.page && !this.onAll && !samePage(gap.page, this.currentPage)) {
      this.currentPage = gap.page
      store('groundwork.page', gap.page)
    }
    // No fit here: the camera flies to the ghost instead.
    this.view = 'map'
    store('groundwork.view', 'map')
    this.selectGap(id)
  },
  selectGap(id: string) {
    this.select(null)
    this.selectedGapId = id
    this.gapAnswer = ''
    this.setDetailsMinimized(false)
    onChange()
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
      onChange()
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
    onChange()
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

  fit() {
    fitHandler()
  },

  markFresh(id: string) {
    if (!this.freshIds.includes(id)) this.freshIds.push(id)
    clearTimeout(freshTimers.get(id))
    freshTimers.set(
      id,
      setTimeout(() => {
        this.freshIds = this.freshIds.filter((f) => f !== id)
        onChange()
      }, 4000),
    )
    onChange()
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
    const body = appendEntry(this.draft.body, 'you', text, new Date().toISOString().slice(0, 10))
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
    onChange()
    // Fit once the new page is drawn, not the one before it.
    setTimeout(fitHandler, 80)
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
    onChange()
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

Alpine.store('gw', state)
