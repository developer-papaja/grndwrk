import Alpine from 'alpinejs'
import { fetchNodes, fetchProject, subscribe } from './api'
import type { ServerEvent } from '../../src/shared/types'
import { bindKeys } from './keys'
import { createScene } from './scene'
import { onFit, onNodesChange, state } from './state'

/** Width of the views rail at the far left. */
const RAIL = 64

const scene = createScene(document.getElementById('scene')!, {
  onNodeClick: (id) => {
    // In focus mode, clicking another card leaves focus and opens it in the map.
    if (state.view === 'focus') {
      state.setView('map')
      if (id.startsWith('gap:')) return state.showGapInMap(id.slice(4))
      if (id.startsWith('story:')) return state.selectStory(id.slice(6))
      return state.goToNode(id)
    }
    if (id.startsWith('gap:')) return state.selectGap(id.slice(4))
    if (id.startsWith('story:')) return state.selectStory(id.slice(6))
    if (state.mode === 'link' && state.selectedId && id !== state.selectedId) void state.toggleLink(id)
    else state.select(id)
  },
  onBackgroundClick: () => {
    if (state.view === 'focus') return
    if (state.mode !== 'link') state.select(null)
  },
})

// Redraw at most once per frame, however many events arrive.
let queued = false
onNodesChange(() => {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    scene.render({
      nodes: Alpine.raw(state.visibleNodes).map((n) => Alpine.raw(n)),
      selectedId: state.selectedId,
      linkMode: state.mode === 'link',
      freshIds: [...state.freshIds],
      gaps: Alpine.raw(state.visibleGaps).map((g) => Alpine.raw(g)),
      selectedGapId: state.selectedGapId,
      stories: Alpine.raw(state.visibleStories).map((st) => Alpine.raw(st)),
      selectedStoryId: state.selectedStoryId,
      focusIds: state.view === 'focus' && state.focusCurrent ? [...state.focusIds] : null,
    })
  })
})

// A handle for poking at the map from the browser console.
Object.assign(window, { groundwork: { state, scene } })

// The map gets the room between the rail, the side panels and the details.
Alpine.effect(() => {
  const wide = window.innerWidth >= 900
  const left = RAIL + (state.view === 'map' && state.listOpen && wide ? 320 : 0)
  scene.setInsets({ left, right: state.rightInset })
})
Alpine.effect(() => scene.setActive(state.view === 'map' || state.view === 'focus'))

// In focus mode the map follows the queue: when the current item changes,
// for any reason (an answer, a skip, a file changed on disk), fly to the next.
let lastFocus: string | undefined
Alpine.effect(() => {
  const key = state.view === 'focus' ? (state.focusCurrent?.key ?? '') : undefined
  if (key === lastFocus) return
  lastFocus = key
  if (key !== undefined) setTimeout(() => state.focusShow())
})

bindKeys(() => document.querySelector<HTMLInputElement>('#capture'), {
  fit: () => state.fit(),
  pan: (on) => scene.setPanning(on),
})
onFit(() => scene.fit())
Alpine.start()

async function reload() {
  try {
    state.replaceAll(await fetchNodes())
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
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event: ServerEvent) => {
    if (event.type === 'node:upsert') state.upsert(event.node)
    else if (event.type === 'node:delete') state.removeLocal(event.id)
    else if (event.type === 'file:change' && event.path === 'project.md') {
      void fetchProject().then((p) => (state.project = p))
    } else if (event.type === 'file:change' && event.path.startsWith('readiness/')) {
      void state.loadReadiness()
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
window.addEventListener('pagehide', disconnect)
if (!document.hidden) connect()
