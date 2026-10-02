import Alpine from 'alpinejs'
import type { GNode, NodeType, Status } from '../../src/shared/types'
import { NODE_TYPES, STATUSES } from '../../src/shared/types'
import { createNode, deleteNode, updateNode } from './api'
import { parseCapture } from './capture'

export type DraftField = 'title' | 'type' | 'altitude' | 'status' | 'body'
const FIELDS: DraftField[] = ['title', 'type', 'altitude', 'status', 'body']

interface Draft {
  title: string
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
let deleteTimer: ReturnType<typeof setTimeout> | undefined
let noteTimer: ReturnType<typeof setTimeout> | undefined

/** Called whenever the nodes change, so the scene can redraw. Set by main.ts. */
let onChange: () => void = () => {}
export function onNodesChange(fn: () => void) {
  onChange = fn
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
  draft: { title: '', type: 'idea', altitude: 3, status: 'open', body: '' } as Draft,
  note: '',
  types: NODE_TYPES,
  statuses: STATUSES,

  get count() {
    return Object.keys(this.nodes).length
  },
  get selected(): GNode | null {
    return this.selectedId ? (this.nodes[this.selectedId] ?? null) : null
  },
  /** One plain sentence under the capture bar about what you can do right now. */
  get hint(): string {
    const sel = this.selected
    if (this.mode === 'link') return 'Click orbs to link or unlink them. Press Esc when you are done.'
    if (sel?.error) return 'This file cannot be read. Fix it in your editor and it updates here.'
    if (sel) return 'New thoughts link to the open one. Press L, then click orbs to link them. Esc closes.'
    if (this.count === 0) return 'Your first thought can be anything. Press Enter to add it.'
    return 'Click an orb to open it. Drag to turn the map, scroll to zoom. Press N to type from anywhere.'
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
      ;(this.draft as Record<DraftField, unknown>)[f] = node[f]
    }
  },

  // Capture bar
  async submitCapture() {
    const parsed = parseCapture(this.capture)
    if (!parsed) return
    const raw = this.capture
    const links = this.selectedId && this.captureLinked ? [this.selectedId] : []
    this.capture = ''
    try {
      this.upsert(await createNode({ ...parsed, links }))
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

Alpine.store('gw', state)
