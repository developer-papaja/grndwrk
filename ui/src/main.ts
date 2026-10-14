import Alpine from 'alpinejs'
import { fetchNodes, fetchProject, subscribe } from './api'
import type { ServerEvent } from '../../src/shared/types'
import { bindKeys } from './keys'
import { state } from './state'

// A handle for poking at the map from the browser console.
Object.assign(window, { groundwork: { state } })

bindKeys(() => document.querySelector<HTMLInputElement>('#capture'), {
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
  const base = name ? `${name} · Groundwork` : 'Groundwork'
  document.title = waiting ? `(${waiting}) Allow to send comments · ${name || 'Groundwork'}` : base
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')
  if (icon) icon.href = waiting ? waitingIcon : plainIcon
})

/** A comment to open once nodes are loaded: from a node:open event, or #write=<id> when Groundwork opened this tab. */
let writeWhenLoaded = /^#write=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] ?? ''
if (writeWhenLoaded) history.replaceState(null, '', location.pathname + location.search)

async function reload() {
  try {
    state.replaceAll(await fetchNodes())
    if (writeWhenLoaded && state.nodes[writeWhenLoaded]) {
      state.writeComment(writeWhenLoaded)
      writeWhenLoaded = ''
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
    void state.loadPairRequests()
    void state.loadSiteRequests()
    void state.loadShots()
    void state.loadRuntime()
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event: ServerEvent) => {
    if (event.type === 'node:upsert') state.upsert(event.node)
    else if (event.type === 'node:delete') state.removeLocal(event.id)
    else if (event.type === 'node:open') {
      // The node may arrive a moment after the request to open it.
      if (state.nodes[event.id]) state.writeComment(event.id)
      else writeWhenLoaded = event.id
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
    } else if (event.type === 'file:change' && event.path.startsWith('screens/')) {
      void state.loadScreens()
    } else if (event.type === 'file:change' && (event.path.startsWith('stories/') || event.path.startsWith('outputs/'))) {
      void state.loadDeliverables()
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
// connection: Groundwork then leaves it to this tab after a restart instead of
// opening another one. (Browsers slow down background timers; often enough.)
setInterval(() => {
  if (document.hidden) fetch('/api/tab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {})
}, 30_000)
window.addEventListener('pagehide', disconnect)
if (!document.hidden) connect()
