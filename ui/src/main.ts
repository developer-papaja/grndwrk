import './rename'
import Alpine from 'alpinejs'
import { fetchNodes, fetchProject, subscribe } from './api'
import type { ServerEvent } from '../../src/shared/types'
import { bindKeys } from './keys'
import { applyTheme, state } from './state'

applyTheme(state.theme)

// A handle for poking at the map from the browser console.
Object.assign(window, { grndwrk: { state } })

// The Add bar grows with what is typed: wider with each character up to a
// limit, then a line at a time up to five (its max-height), then it scrolls.
// Growing smoothly, never in a step, so the text does not jump.
const measure = document.createElement('canvas').getContext('2d')
Object.assign(window, {
  fitCapture(el: HTMLTextAreaElement) {
    if (measure) {
      measure.font = getComputedStyle(el).font
      const text = measure.measureText(el.value.replace(/\s+/g, ' ')).width
      el.style.width = `${Math.min(420, Math.max(260, Math.ceil(text) + 4))}px`
    }
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  },
})

bindKeys(() => document.querySelector<HTMLTextAreaElement>('#capture'), {
  layout: () => state.cycleLayout(),
})
Alpine.start()

// The tab says when a phone or a site waits to be allowed, like a count of
// unread messages, so it is seen from another tab: "(1) Allow to send comments · Clinic".
// Its name is the project's, so several maps open at once can be told apart.
const plainIcon = document.querySelector<HTMLLinkElement>('link[rel=icon]')?.href ?? ''
const waitingIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#0d99ff"/><circle cx="12.5" cy="3.5" r="3.5" fill="#f24822"/></svg>')}`
Alpine.effect(() => {
  const waiting = state.pairRequests.length + state.siteRequests.length
  const name = typeof state.project.name === 'string' && state.project.name ? state.project.name : ''
  const base = name ? `${name} · grndwrk` : 'grndwrk'
  document.title = waiting ? `(${waiting}) Allow to send comments · ${name || 'grndwrk'}` : base
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')
  if (icon) icon.href = waiting ? waitingIcon : plainIcon
})

/**
 * A comment to open once nodes are loaded: from a node:open event, or
 * #write=<id> (its title, to write it) or #reply=<id> (its reply box, to say
 * what is still wrong after a reject) when grndwrk opened this tab.
 */
const opening = /^#(write|reply)=([A-Za-z0-9_-]+)$/.exec(location.hash)
let writeWhenLoaded = opening?.[2] ?? ''
let replyWhenLoaded = opening?.[1] === 'reply'
if (writeWhenLoaded) history.replaceState(null, '', location.pathname + location.search)

async function reload() {
  try {
    state.replaceAll(await fetchNodes())
    if (writeWhenLoaded && state.nodes[writeWhenLoaded]) {
      state.writeComment(writeWhenLoaded, replyWhenLoaded)
      writeWhenLoaded = ''
      replyWhenLoaded = false
    }
  } catch (err) {
    state.flash(err instanceof Error ? err.message : String(err))
  }
}

const handlers = {
  // On every (re)connect, fetch the full list, since events may have been missed while away.
  onOpen: () => {
    state.live = true
    state.retryUnsaved()
    void reload()
    void fetchProject().then((p) => (state.project = p))
    void state.loadReadiness()
    void state.loadDeliverables()
    void state.loadScreens()
    void state.loadPersonas()
    void state.loadPairRequests()
    void state.loadSiteRequests()
    void state.loadShots()
    void state.loadRuntime()
    if (state.view === 'docs') void state.loadDocs()
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event: ServerEvent) => {
    if (event.type === 'node:upsert') state.upsert(event.node)
    else if (event.type === 'node:delete') state.removeLocal(event.id)
    else if (event.type === 'node:open') {
      // The node may arrive a moment after the request to open it.
      if (state.nodes[event.id]) state.writeComment(event.id, event.reply === true)
      else {
        writeWhenLoaded = event.id
        replyWhenLoaded = event.reply === true
      }
    }
    else if (event.type === 'pair:request') state.addPairRequest(event.request)
    else if (event.type === 'pair:done') state.dropPairRequest(event.id)
    else if (event.type === 'site:request') state.addSiteRequest(event.origin)
    else if (event.type === 'site:done') {
      state.dropSiteRequest(event.origin)
      void state.loadSiteRequests()
    }
    else if (event.type === 'file:change' && event.path.startsWith('shots/')) void state.loadShots()
    else if (event.type === 'file:change' && event.path === 'project.md') {
      void fetchProject().then((p) => (state.project = p))
      void state.loadRuntime()
    } else if (event.type === 'file:change' && event.path.startsWith('readiness/')) {
      void state.loadReadiness()
      if (state.view === 'docs') void state.loadDocs()
    } else if (event.type === 'file:change' && event.path.startsWith('screens/')) {
      void state.loadScreens()
    } else if (event.type === 'file:change' && event.path.startsWith('personas/')) {
      void state.loadPersonas()
    } else if (event.type === 'file:change' && (event.path.startsWith('stories/') || event.path.startsWith('outputs/'))) {
      void state.loadDeliverables()
      if (event.path.startsWith('outputs/personas')) void state.loadPersonas()
    }
  },
}

/**
 * Only the tab in view keeps a live connection. Browsers allow six open
 * connections per site across all tabs, and each live connection holds one,
 * so a handful of open tabs would leave none for loading or saving.
 * A tab coming back into view reconnects and reloads everything.
 */
let source: EventSource | null = null
function connect() {
  if (!source) source = subscribe(handlers)
}
function disconnect() {
  source?.close()
  source = null
}
document.addEventListener('visibilitychange', () => (document.hidden ? disconnect() : connect()))
// In the background, say now and then that this tab is still open, without a
// connection: grndwrk then leaves it to this tab after a restart instead of
// opening another one. (Browsers slow down background timers; often enough.)
setInterval(() => {
  if (document.hidden) fetch('/api/tab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {})
}, 30_000)
window.addEventListener('pagehide', disconnect)
if (!document.hidden) connect()
