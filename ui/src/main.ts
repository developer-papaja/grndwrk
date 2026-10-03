import Alpine from 'alpinejs'
import { fetchNodes, fetchProject, subscribe } from './api'
import type { ServerEvent } from '../../src/shared/types'
import { bindKeys } from './keys'
import { createScene } from './scene'
import { onFit, onNodesChange, state } from './state'

const scene = createScene(document.getElementById('scene')!, {
  onNodeClick: (id) => {
    if (state.mode === 'link' && state.selectedId && id !== state.selectedId) void state.toggleLink(id)
    else state.select(id)
  },
  onBackgroundClick: () => {
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
    })
  })
})

// A handle for poking at the map from the browser console.
Object.assign(window, { groundwork: { state, scene } })

// The map gets the room between the side panels.
Alpine.effect(() => {
  const wide = window.innerWidth >= 900
  const left = state.listOpen && wide ? 320 : 0
  const right = state.detailsVisible ? 360 : 0
  scene.setInsets({ left, right })
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
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event: ServerEvent) => {
    if (event.type === 'node:upsert') state.upsert(event.node)
    else if (event.type === 'node:delete') state.removeLocal(event.id)
    else if (event.type === 'file:change' && event.path === 'project.md') {
      void fetchProject().then((p) => (state.project = p))
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
