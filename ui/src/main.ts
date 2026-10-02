import Alpine from 'alpinejs'
import ForceGraph3D from '3d-force-graph'
import { GridHelper } from 'three'
import type { GNode, ServerEvent } from '../../src/shared/types'
import { fetchNodes, fetchProject, subscribe } from './api'

const nodes = new Map<string, GNode>()

const store = Alpine.reactive({
  live: false,
  count: 0,
  project: {} as Record<string, unknown>,
})
Alpine.store('gw', store)
Alpine.start()

const graph = new ForceGraph3D(document.getElementById('scene')!, { controlType: 'orbit' })
  .backgroundColor('#0e1116')
  .showNavInfo(false)
  .nodeLabel('title')

// A faint floor so orbiting reads even before there are nodes.
const floor = new GridHelper(400, 20, 0x2a313c, 0x1a1f27)
floor.position.y = -120
graph.scene().add(floor)
graph.cameraPosition({ x: 0, y: 60, z: 320 })

window.addEventListener('resize', () => graph.width(window.innerWidth).height(window.innerHeight))

/** Phase 1 replaces this with real node rendering. For now, show what is on disk. */
function render() {
  store.count = nodes.size
  const seen = new Set<string>()
  const links: { source: string; target: string }[] = []
  for (const n of nodes.values()) {
    for (const l of n.links) {
      const key = [n.id, l].sort().join('|')
      if (!nodes.has(l) || seen.has(key)) continue
      seen.add(key)
      links.push({ source: n.id, target: l })
    }
  }
  // Keep existing node objects so the layout does not jump on every update.
  const previous = new Map(graph.graphData().nodes.map((n) => [n.id as string, n]))
  graph.graphData({
    nodes: [...nodes.values()].map((n) => Object.assign(previous.get(n.id) ?? {}, n)),
    links,
  })
}

function apply(event: ServerEvent) {
  if (event.type === 'node:upsert') nodes.set(event.node.id, event.node)
  else if (event.type === 'node:delete') nodes.delete(event.id)
  else if (event.type === 'file:change' && event.path === 'project.md') void loadProject()
  render()
}

async function loadProject() {
  store.project = await fetchProject()
}

async function reload() {
  nodes.clear()
  for (const n of await fetchNodes()) nodes.set(n.id, n)
  render()
}

subscribe({
  // On every (re)connect, fetch the full list, since events may have been missed while offline.
  onOpen: () => {
    store.live = true
    void reload()
    void loadProject()
  },
  onError: () => {
    store.live = false
  },
  onEvent: apply,
})
