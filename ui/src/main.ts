import Alpine from 'alpinejs'
import { fetchNodes, fetchProject, subscribe } from './api'
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
      nodes: Object.values(Alpine.raw(state.nodes)),
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

subscribe({
  // On every (re)connect, fetch the full list, since events may have been missed while offline.
  onOpen: () => {
    state.live = true
    void reload()
    void fetchProject().then((p) => (state.project = p))
  },
  onError: () => {
    state.live = false
  },
  onEvent: (event) => {
    if (event.type === 'node:upsert') state.upsert(event.node)
    else if (event.type === 'node:delete') state.removeLocal(event.id)
    else if (event.type === 'file:change' && event.path === 'project.md') {
      void fetchProject().then((p) => (state.project = p))
    }
  },
})
