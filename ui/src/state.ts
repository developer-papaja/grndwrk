import Alpine from 'alpinejs'
import type { GNode, NodeType, Status } from '../../src/shared/types'
import { NODE_TYPES, STATUSES } from '../../src/shared/types'
import { createNode, deleteNode, savePages, updateNode } from './api'
import { mergePages, pageOf, samePage } from '../../src/shared/pages'
import { parseCapture, sameTitle } from './capture'
import { ALTITUDE_WORDS, topicColumns } from './layout'
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
    return groupForList(this.visibleNodes, this.query)
  },
  get listRows(): GNode[] {
    return flatten(this.listGroups.filter((g) => !this.isCollapsed(g.key)))
  },
  get detailsVisible(): boolean {
    return !!this.selected && !this.detailsMinimized
  },
  /**
   * The space between the side panels, for bars that float over the map.
   * An object, not a string: a string binding would replace the whole style
   * attribute and undo x-show.
   */
  get mapArea(): { left: string; right: string } {
    const wide = window.innerWidth >= 900
    const left = this.listOpen && wide ? 320 : 0
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

  select(id: string | null) {
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
      pending.delete(f)
      this.flash(errorText(err))
      this.syncDraft()
    }
  },
  flushAll() {
    for (const f of [...pending]) void this.flush(f)
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
