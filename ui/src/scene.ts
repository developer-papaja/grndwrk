import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import { GridHelper, Group, Mesh, MeshLambertMaterial, SphereGeometry } from 'three'
import type { GNode } from '../../src/shared/types'

const COLORS = {
  background: '#0e1116',
  node: '#c9c98a',
  selected: '#f4f1d0',
  linked: '#e3dfa8',
  error: '#d0796b',
  label: 'rgba(223, 227, 234, 0.82)',
  labelSelected: '#ffffff',
  link: 'rgba(160, 170, 185, 0.28)',
  linkSelected: 'rgba(240, 236, 200, 0.75)',
}
const RADIUS = 4
const LABEL_MAX = 40

interface GraphNode {
  id: string
  title: string
  links: string[]
  error?: string
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  mesh?: Mesh<SphereGeometry, MeshLambertMaterial>
  label?: SpriteText
}
interface GraphLink {
  source: string | GraphNode
  target: string | GraphNode
}

export interface SceneView {
  nodes: GNode[]
  selectedId: string | null
  linkMode: boolean
}

const geometry = new SphereGeometry(RADIUS, 20, 14)

export function createScene(el: HTMLElement, handlers: { onNodeClick: (id: string) => void; onBackgroundClick: () => void }) {
  let view: SceneView = { nodes: [], selectedId: null, linkMode: false }
  let structure = ''

  // The constructor type does not carry node and link types, so give them here.
  const graph = (new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<GraphNode, GraphLink>)
    .backgroundColor(COLORS.background)
    .showNavInfo(false)
    // Position comes from the layout (and from altitude in Phase 2), not from dragging.
    // Node drag also crashes the orbit controls in this three.js version when a drag ends.
    .enableNodeDrag(false)
    .nodeLabel(() => '')
    .nodeThreeObject((n) => buildObject(n))
    .linkWidth(0.6)
    .linkOpacity(1)
    .linkColor((l) => (touchesSelected(l) ? COLORS.linkSelected : COLORS.link))
    .onNodeClick((n) => handlers.onNodeClick(n.id))
    .onBackgroundClick(() => handlers.onBackgroundClick())

  graph.d3Force('gravity', gravity(0.04))
  // Frame the map once it first settles. After that the camera is yours.
  let framed = false
  graph.onEngineStop(() => {
    if (framed || graph.graphData().nodes.length === 0) return
    framed = true
    graph.zoomToFit(600, 140)
  })

  // A faint floor so orbiting reads even when the map is nearly empty.
  const floor = new GridHelper(400, 20, 0x2a313c, 0x1a1f27)
  floor.position.y = -120
  graph.scene().add(floor)
  graph.cameraPosition({ x: 0, y: 60, z: 320 })
  window.addEventListener('resize', () => graph.width(window.innerWidth).height(window.innerHeight))

  function touchesSelected(l: GraphLink): boolean {
    if (!view.selectedId) return false
    const s = typeof l.source === 'string' ? l.source : l.source.id
    const t = typeof l.target === 'string' ? l.target : l.target.id
    return s === view.selectedId || t === view.selectedId
  }

  function buildObject(n: GraphNode) {
    const group = new Group()
    n.mesh = new Mesh(geometry, new MeshLambertMaterial({ color: COLORS.node, transparent: true }))
    n.label = new SpriteText('', 3, COLORS.label)
    n.label.fontFace = 'Inter, system-ui, sans-serif'
    n.label.position.y = -(RADIUS + 4)
    // Labels draw on top so they stay readable when spheres overlap.
    n.label.material.depthWrite = false
    // Sprites break the library's click picking, and the sphere is the target anyway.
    n.label.raycast = () => {}
    group.add(n.mesh, n.label)
    style(n)
    return group
  }

  /** Update one node's look in place. No layout work happens here. */
  function style(n: GraphNode) {
    if (!n.mesh || !n.label) return
    const selected = n.id === view.selectedId
    const linkedToSelected = !!view.selectedId && n.links.includes(view.selectedId)
    const color = n.error ? COLORS.error : selected ? COLORS.selected : linkedToSelected ? COLORS.linked : COLORS.node
    n.mesh.material.color.set(color)
    n.mesh.scale.setScalar(selected ? 1.45 : 1)
    const title = n.error ? `${n.id}.md (cannot read)` : n.title
    n.label.text = title.length > LABEL_MAX ? `${title.slice(0, LABEL_MAX - 1)}…` : title
    n.label.color = selected ? COLORS.labelSelected : COLORS.label
    n.label.position.y = -(RADIUS * (selected ? 1.45 : 1) + 4)
  }

  function render(next: SceneView) {
    view = next
    const existing = new Map(graph.graphData().nodes.map((n) => [n.id, n]))
    const ids = new Set(next.nodes.map((n) => n.id))

    const links: GraphLink[] = []
    const seen = new Set<string>()
    for (const n of next.nodes) {
      for (const l of n.links) {
        const key = n.id < l ? `${n.id}|${l}` : `${l}|${n.id}`
        if (!ids.has(l) || seen.has(key)) continue
        seen.add(key)
        links.push({ source: n.id, target: l })
      }
    }

    const nodes = next.nodes.map((n) => {
      const g = existing.get(n.id) ?? placeNear({ id: n.id, title: n.title, links: n.links }, existing)
      g.title = n.title
      g.links = [...n.links]
      g.error = n.error
      return g
    })

    // Only hand the graph new data when nodes or links were added or removed.
    // That keeps the layout calm while titles are typed.
    const nextStructure = [...ids].sort().join(',') + '#' + [...seen].sort().join(',')
    if (nextStructure !== structure) {
      structure = nextStructure
      graph.graphData({ nodes, links })
    }
    for (const n of nodes) style(n)
    graph.linkColor(graph.linkColor())
    el.style.cursor = next.linkMode ? 'crosshair' : ''
  }

  /** Start a new node next to a node it links to, so it does not fly in from the middle. */
  function placeNear(n: GraphNode, existing: Map<string, GraphNode>): GraphNode {
    const anchor = n.links.map((l) => existing.get(l)).find((a) => a?.x !== undefined)
    if (anchor) {
      const jitter = () => (Math.random() - 0.5) * 30
      n.x = anchor.x! + jitter()
      n.y = anchor.y! + jitter()
      n.z = anchor.z! + jitter()
    }
    return n
  }

  /**
   * A gentle pull toward the middle. Without it, unlinked thoughts push each
   * other away until they drift out of view.
   */
  function gravity(strength: number) {
    let nodes: GraphNode[] = []
    const force = (alpha: number) => {
      for (const n of nodes) {
        n.vx = (n.vx ?? 0) - (n.x ?? 0) * strength * alpha
        n.vy = (n.vy ?? 0) - (n.y ?? 0) * strength * alpha
        n.vz = (n.vz ?? 0) - (n.z ?? 0) * strength * alpha
      }
    }
    force.initialize = (ns: GraphNode[]) => (nodes = ns)
    return force
  }

  /** Where a node is on screen, for debugging and browser tests. */
  function screenPosition(id: string) {
    const n = graph.graphData().nodes.find((g) => g.id === id)
    if (!n || n.x === undefined) return null
    return graph.graph2ScreenCoords(n.x, n.y!, n.z!)
  }

  return { render, screenPosition }
}
