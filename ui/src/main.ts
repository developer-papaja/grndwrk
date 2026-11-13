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

// Remember where the details were opened, so another view in the rail does not show them (detailsVisible).
let openedKey = ''
Alpine.effect(() => {
  const key = [state.selectedId, state.selectedGapId, state.selectedStoryId, state.reportOpen].join('|')
  if (key === openedKey) return
  openedKey = key
  state.detailsFrom = state.view
})

// The tab says when a phone or a site waits to be allowed, like a count of
// unread messages, so it is seen from another tab: "(1) Allow to send comments · Clinic".
// Its name is the project's, so several maps open at once can be told apart.
// The icon is the project's badge (its initials and color, as on the rail),
// grey while grndwrk is not connected, with a red count of who waits to be allowed.
const xml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
function badgeIcon(initials: string, color: string, connected: boolean, waiting: number): string {
  const letters = initials.slice(0, 3)
  const size = letters.length > 2 ? 11 : letters.length > 1 ? 14 : 18
  const count = waiting > 9 ? '9+' : String(waiting)
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect x="1" y="1" width="30" height="30" rx="8" fill="${xml(connected ? color : '#9ca3af')}"/>`,
    `<text x="16" y="16.5" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,system-ui,sans-serif" font-weight="700" font-size="${size}" fill="${connected ? '#fff' : '#f3f4f6'}">${xml(letters)}</text>`,
    waiting ? `<circle cx="24" cy="8" r="8" fill="#f24822" stroke="#fff" stroke-width="1.5"/><text x="24" y="8.5" text-anchor="middle" dominant-baseline="central" font-family="-apple-system,system-ui,sans-serif" font-weight="700" font-size="${count.length > 1 ? 8 : 10}" fill="#fff">${count}</text>` : '',
    '</svg>',
  ].join('')
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
Alpine.effect(() => {
  const waiting = state.pairRequests.length + state.siteRequests.length + (state.relay.waiting?.length ?? 0)
  const name = typeof state.project.name === 'string' && state.project.name ? state.project.name : ''
  const base = name ? `${name} · grndwrk` : 'grndwrk'
  document.title = tabTitle(waiting ? `(${waiting}) Allow to send comments · ${name || 'grndwrk'}` : base)
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')
  if (icon) icon.href = badgeIcon(state.projectInitials || 'G', state.projectColor, state.live, waiting)
})

// New comments through the relay join the tab's title: "(2 new) Clinic · grndwrk".
// Opening one in the panel marks it seen (src/shared/unseen.ts).
function tabTitle(title: string): string {
  const fresh = state.newComments.length
  if (!fresh) return title
  return title.startsWith('(') ? title.replace(/ · /, ` · ${fresh} new · `) : `(${fresh} new) ${title}`
}
Alpine.effect(() => {
  const n = state.selectedId ? state.nodes[state.selectedId] : null
  if (n) queueMicrotask(() => state.markSeen(n))
})
/** Nodes were loaded once, so any that show up later arrived while this tab was open. */
let loadedOnce = false

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
    const nodes = await fetchNodes()
    const before = loadedOnce ? new Set(Object.keys(state.nodes)) : null
    state.replaceAll(nodes)
    if (before) state.noteArrived(nodes.map((n) => n.id).filter((id) => !before.has(id)))
    loadedOnce = true
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
    void state.loadRelay()
    void state.loadAuthors()
    void state.loadWaiting()
    void state.loadShots()
    void state.loadRuntime()
    if (state.view === 'docs') void state.loadDocs()
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event: ServerEvent) => {
    if (event.type === 'node:upsert') {
      const arrived = loadedOnce && !state.nodes[event.node.id]
      state.upsert(event.node)
      if (arrived) state.noteArrived([event.node.id])
      // Thoughts that came by git (a pull) have no `by:`: who committed them is read again shortly.
      if (!state.authorOf(event.node)) {
        clearTimeout(authorsTimer)
        authorsTimer = setTimeout(() => void state.loadAuthors(), 5000)
      }
    }
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
    else if (event.type === 'relay:waiting') void state.loadRelay()
    else if (event.type === 'site:done') {
      state.dropSiteRequest(event.origin)
      void state.loadSiteRequests()
    }
    else if (event.type === 'file:change' && event.path.startsWith('shots/')) void state.loadShots()
    else if (event.type === 'file:change' && event.path.startsWith('waiting/')) void state.loadWaiting()
    else if (event.type === 'file:change' && event.path === 'project.md') {
      void fetchProject().then((p) => (state.project = p))
      void state.loadRuntime()
      void state.loadWaiting()
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
let authorsTimer: ReturnType<typeof setTimeout> | undefined
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
// Its answer also keeps the tab's icon honest: grey once grndwrk stops answering.
function stillOpen() {
  if (!document.hidden) return
  fetch('/api/tab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((r) => (state.live = r.ok))
    .catch(() => (state.live = false))
}
setInterval(stillOpen, 30_000)
stillOpen()
window.addEventListener('pagehide', (e) => {
  disconnect()
  // Closed, not kept for going back: grndwrk opens a new tab next time instead of waiting for this one.
  if (!e.persisted) navigator.sendBeacon('/api/tab?gone=1')
})
if (!document.hidden) connect()
