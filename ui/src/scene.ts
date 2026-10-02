import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import {
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  SphereGeometry,
  Vector3,
} from 'three'
import type { GNode, NodeType, Status } from '../../src/shared/types'
import { ALTITUDE_WORDS, altitudeY, linkStrength, topicColumns, topicKey, wrapLabel, type Column } from './layout'
import { SCENE_COLORS, TYPE_COLORS } from './palette'

const RADIUS = 4
/** Labels are fully visible up to NEAR from the camera and gone beyond FAR. */
const LABEL_NEAR = 700
const LABEL_FAR = 1600
/** How close the camera comes when it flies to a node. */
const FLY_DISTANCE = 280
/** Sideways room for one label, between nodes on the same line of a column. */
const ROW_GAP = 80

interface GraphNode {
  id: string
  title: string
  type: NodeType
  status: Status
  altitude: number
  links: string[]
  topic: string
  error?: string
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  /** Height is pinned to altitude. fy eases toward it so a change is visible. */
  fy?: number
  mesh?: Mesh<SphereGeometry, MeshStandardMaterial>
  halo?: Mesh<SphereGeometry, MeshBasicMaterial>
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

/**
 * Text that keeps the same size on screen at any zoom, so labels stay readable
 * in the overview. Height is a fraction of the view, roughly: 0.011 is about 13px
 * on a 900px tall window.
 */
function makeText(text: string, height: number, color: string): SpriteText {
  const t = new SpriteText(text, height, color)
  t.fontFace = 'Inter, system-ui, sans-serif'
  t.fontSize = 48
  t.material.sizeAttenuation = false
  t.material.depthWrite = false
  t.material.transparent = true
  // Sprites break the library's click picking, and they are never the target.
  t.raycast = () => {}
  return t
}

const geometry = new SphereGeometry(RADIUS, 24, 16)
// A faint shell around settled nodes, so settled reads as solid and done.
const haloGeometry = new SphereGeometry(RADIUS * 1.55, 20, 14)
// An invisible, larger sphere around each orb, so small orbs are easy to click.
const hitGeometry = new SphereGeometry(RADIUS * 1.7, 12, 8)
const hitMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false })

export function createScene(el: HTMLElement, handlers: { onNodeClick: (id: string) => void; onBackgroundClick: () => void }) {
  let view: SceneView = { nodes: [], selectedId: null, linkMode: false }
  let structure = ''
  let layoutKey = ''
  let columns = new Map<string, Column>()
  let hoveredId: string | null = null
  let lastSelected: string | null = null

  // The constructor type does not carry node and link types, so give them here.
  const graph = (new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<GraphNode, GraphLink>)
    .backgroundColor(SCENE_COLORS.background)
    .showNavInfo(false)
    // Position comes from altitude and topic, not from dragging. Node drag
    // also crashes the orbit controls in this three.js version when a drag ends.
    .enableNodeDrag(false)
    .nodeLabel(() => '')
    .nodeThreeObject((n) => buildObject(n))
    .linkWidth((l) => (touchesSelected(l) ? 1.1 : 0.6))
    .linkOpacity(1)
    .linkColor((l) => linkColor(l))
    .onNodeClick((n) => handlers.onNodeClick(n.id))
    .onNodeHover((n) => {
      hoveredId = n?.id ?? null
      el.style.cursor = view.linkMode ? 'crosshair' : n ? 'pointer' : ''
    })
    .onBackgroundClick(() => handlers.onBackgroundClick())

  graph.d3Force('layout', layoutForce())
  graph.d3Force('center', null)

  // Never tip the camera under the map or straight overhead.
  const controls = graph.controls() as { minPolarAngle: number; maxPolarAngle: number; target: Vector3 }
  controls.minPolarAngle = Math.PI * 0.18
  controls.maxPolarAngle = Math.PI * 0.62

  // Frame the map once, shortly after the first nodes arrive. Height and
  // columns are fixed, so the shape is clear long before the layout settles.
  // After that the camera is yours.
  let framed = false
  function frameOnce() {
    if (framed || graph.graphData().nodes.length === 0) return
    framed = true
    setTimeout(fit, 1200)
  }
  graph.cameraPosition({ x: 0, y: 90, z: 460 })
  window.addEventListener('resize', () => graph.width(window.innerWidth).height(window.innerHeight))

  const guides = new Group()
  const topicLabels = new Group()
  graph.scene().add(guides, topicLabels)

  function linkEnds(l: GraphLink): [GraphNode | undefined, GraphNode | undefined] {
    const byId = (v: string | GraphNode) => (typeof v === 'string' ? graph.graphData().nodes.find((n) => n.id === v) : v)
    return [byId(l.source), byId(l.target)]
  }

  function touchesSelected(l: GraphLink): boolean {
    if (!view.selectedId) return false
    const [s, t] = linkEnds(l)
    return s?.id === view.selectedId || t?.id === view.selectedId
  }

  /** Links inside a topic read clearly. Links across topics stay in the background. */
  function linkColor(l: GraphLink): string {
    const [s, t] = linkEnds(l)
    const same = !!s && !!t && s.topic === t.topic
    if (touchesSelected(l)) return 'rgba(240, 236, 210, 0.8)'
    return same ? 'rgba(160, 170, 185, 0.35)' : 'rgba(160, 170, 185, 0.1)'
  }

  function buildObject(n: GraphNode) {
    const group = new Group()
    n.mesh = new Mesh(
      geometry,
      new MeshStandardMaterial({ roughness: 0.5, metalness: 0.05, transparent: true, emissiveIntensity: 0.22 }),
    )
    n.halo = new Mesh(haloGeometry, new MeshBasicMaterial({ transparent: true, opacity: 0.12, depthWrite: false }))
    n.halo.raycast = () => {}
    n.label = makeText('', 0.011, SCENE_COLORS.label)
    // Hang the text below its anchor point, which sits just under the orb.
    n.label.center.set(0.5, 1.15)
    group.add(n.mesh, n.halo, n.label, new Mesh(hitGeometry, hitMaterial))
    style(n)
    return group
  }

  /** Update one node's look in place. No layout work happens here. */
  function style(n: GraphNode) {
    if (!n.mesh || !n.label || !n.halo) return
    const selected = n.id === view.selectedId
    const linked = !!view.selectedId && n.links.includes(view.selectedId)
    const color = n.error ? SCENE_COLORS.error : TYPE_COLORS[n.type]
    const parked = n.status === 'parked'
    const scale = (selected ? 1.4 : 1) * (parked ? 0.8 : 1)

    n.mesh.material.color.set(color)
    n.mesh.material.emissive.set(color)
    n.mesh.material.emissiveIntensity = selected ? 0.55 : linked ? 0.35 : 0.2
    n.mesh.material.opacity = parked ? 0.35 : 1
    n.mesh.scale.setScalar(scale)
    n.halo.visible = n.status === 'settled'
    n.halo.material.color.set(color)
    n.halo.scale.setScalar(scale)

    const title = n.error ? `${n.id}.md (cannot read)` : n.title
    n.label.text = wrapLabel(title)
    n.label.position.y = -(RADIUS * scale + 1)
  }

  /** Every frame: ease heights toward altitude, and fade far labels. */
  function frame() {
    for (const n of graph.graphData().nodes) {
      const target = altitudeY(n.altitude)
      if (n.fy === undefined) n.fy = target
      else if (Math.abs(n.fy - target) > 0.1) n.fy += (target - n.fy) * 0.12
      else n.fy = target
    }
    fadeLabels()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  /**
   * Labels fade out with distance, and a label that would cover one already
   * shown is hidden. The selected node, its links and the hovered node go
   * first, then higher altitudes. Hover or zoom in to see a hidden one.
   */
  function fadeLabels() {
    const camera = graph.camera() as PerspectiveCamera
    const cam = camera.position
    const width = el.clientWidth
    const pxPerUnit = el.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360))
    const nodes = graph.graphData().nodes.filter((n) => n.label && n.x !== undefined)
    const isFocus = (n: GraphNode) =>
      n.id === view.selectedId || n.id === hoveredId || (!!view.selectedId && n.links.includes(view.selectedId))
    nodes.sort((a, b) => Number(isFocus(b)) - Number(isFocus(a)) || b.altitude - a.altitude)
    const placed: { x1: number; x2: number; y1: number; y2: number }[] = []
    for (const n of nodes) {
      const focus = isFocus(n)
      const d = cam.distanceTo(new Vector3(n.x, n.y, n.z))
      const t = Math.min(1, Math.max(0, (d - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR)))
      const base = n.status === 'parked' ? 0.5 : 0.9
      let opacity = focus ? 1 : base * (1 - t)

      // The label's box on screen. It hangs under the orb, and a fixed-size
      // sprite covers scale / (2 tan(fov / 2)) of the view's height.
      const p = graph.graph2ScreenCoords(n.x!, n.y!, n.z!)
      const h = (n.label!.scale.y * pxPerUnit) * 0.9
      const w = (n.label!.scale.x * pxPerUnit) * 0.9
      const box = { x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y + 4, y2: p.y + 4 + h }
      const offscreen = box.x2 < 0 || box.x1 > width
      const covered = placed.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)
      if (covered && !focus) opacity = 0
      else if (!offscreen && opacity > 0.05) placed.push(box)
      n.label!.material.opacity = opacity
    }
  }

  function render(next: SceneView) {
    view = next
    const existing = new Map(graph.graphData().nodes.map((n) => [n.id, n]))
    const ids = new Set(next.nodes.map((n) => n.id))
    columns = topicColumns(next.nodes)

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
      const g = existing.get(n.id) ?? place(n, existing)
      g.title = n.title
      g.type = n.type
      g.status = n.status
      g.altitude = n.altitude
      g.links = [...n.links]
      g.topic = topicKey(n.topic)
      g.error = n.error
      return g
    })

    // Only hand the graph new data when nodes or links were added or removed.
    // That keeps the layout calm while titles are typed.
    const nextStructure = [...ids].sort().join(',') + '#' + [...seen].sort().join(',')
    // Altitude and topic move nodes, so a change there wakes the layout up.
    const nextLayout = nodes.map((n) => `${n.id}:${n.topic}:${n.altitude}`).sort().join(',')
    if (nextStructure !== structure) {
      structure = nextStructure
      layoutKey = nextLayout
      graph.graphData({ nodes, links })
      updateLinkStrength()
    } else if (nextLayout !== layoutKey) {
      layoutKey = nextLayout
      updateLinkStrength()
      graph.d3ReheatSimulation()
    }
    for (const n of nodes) style(n)
    graph.linkColor(graph.linkColor()).linkWidth(graph.linkWidth())
    drawGuides()
    frameOnce()
    if (next.selectedId && next.selectedId !== lastSelected) flyTo(next.selectedId)
    lastSelected = next.selectedId
    el.style.cursor = next.linkMode ? 'crosshair' : ''
  }

  function updateLinkStrength() {
    const degree = new Map<string, number>()
    for (const n of graph.graphData().nodes) degree.set(n.id, n.links.length)
    const force = graph.d3Force('link') as { strength?: (fn: (l: GraphLink) => number) => void } | undefined
    force?.strength?.((l) => {
      const [s, t] = linkEnds(l)
      if (!s || !t) return 0
      return linkStrength(s.topic === t.topic, degree.get(s.id) ?? 1, degree.get(t.id) ?? 1)
    })
  }

  /** Start a new node next to a node it links to, or in its own column at its height. */
  function place(n: GNode, existing: Map<string, GraphNode>): GraphNode {
    const g: GraphNode = { id: n.id, title: n.title, type: n.type, status: n.status, altitude: n.altitude, links: n.links, topic: topicKey(n.topic) }
    const jitter = () => (Math.random() - 0.5) * 30
    const anchor = n.links.map((l) => existing.get(l)).find((a) => a?.x !== undefined)
    g.x = (anchor?.x ?? columns.get(g.topic)?.x ?? 0) + jitter()
    g.y = g.fy = altitudeY(n.altitude)
    g.z = (anchor?.z ?? 0) + jitter()
    return g
  }

  /**
   * Height is pinned to altitude (see frame). Sideways, a soft pull draws nodes
   * into their topic's column, and depth gets a light pull back to the middle.
   */
  function layoutForce() {
    let nodes: GraphNode[] = []
    const force = (alpha: number) => {
      for (const n of nodes) {
        const colX = columns.get(n.topic)?.x ?? 0
        n.vx = (n.vx ?? 0) + (colX - (n.x ?? 0)) * 0.035 * alpha
        n.vz = (n.vz ?? 0) - (n.z ?? 0) * 0.08 * alpha
      }
      // Nodes on the same line of the same column push apart sideways, so
      // their labels do not sit on top of each other when seen from the front.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          if (a.topic !== b.topic || a.altitude !== b.altitude) continue
          const dx = (a.x ?? 0) - (b.x ?? 0)
          const gap = ROW_GAP - Math.abs(dx)
          if (gap <= 0) continue
          const push = gap * 0.03 * alpha * (dx >= 0 ? 1 : -1) || 0.2
          a.vx = (a.vx ?? 0) + push
          b.vx = (b.vx ?? 0) - push
        }
      }
    }
    force.initialize = (ns: GraphNode[]) => (nodes = ns)
    return force
  }

  /** One faint line per altitude, with its meaning in words, and a name over each topic. */
  let guideKey = ''
  function drawGuides() {
    const key = [...columns.values()].map((c) => `${c.name}@${c.x}`).join('|')
    if (key === guideKey) return
    guideKey = key
    for (const obj of [...guides.children, ...topicLabels.children]) disposeObject(obj)
    guides.clear()
    topicLabels.clear()
    if (view.nodes.length === 0) return
    const xs = [...columns.values()].map((c) => c.x)
    const left = Math.min(...xs) - 110
    const right = Math.max(...xs) + 110
    const material = new LineBasicMaterial({ color: SCENE_COLORS.guide, transparent: true, opacity: 0.8 })
    for (let a = 1; a <= 5; a++) {
      const y = altitudeY(a)
      guides.add(new Line(new BufferGeometry().setFromPoints([new Vector3(left, y, 0), new Vector3(right, y, 0)]), material))
      const word = makeText(`${a} ${ALTITUDE_WORDS[a]}`, 0.0095, SCENE_COLORS.guideText)
      // Right aligned against the start of the line.
      word.center.set(1.05, 0.5)
      word.position.set(left, y, 0)
      guides.add(word)
    }
    for (const col of columns.values()) {
      const label = makeText(col.name, 0.016, SCENE_COLORS.topic)
      label.position.set(col.x, altitudeY(5) + 32, 0)
      topicLabels.add(label)
    }
  }

  /** Ease the camera to a node, keeping the angle you were looking from. */
  function flyTo(id: string) {
    const n = graph.graphData().nodes.find((g) => g.id === id)
    if (!n || n.x === undefined) return
    const target = new Vector3(n.x, n.y, n.z)
    const dir = graph.camera().position.clone().sub(controls.target).normalize()
    const pos = target.clone().add(dir.multiplyScalar(FLY_DISTANCE))
    graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: target.x, y: target.y, z: target.z }, 600)
  }

  function fit() {
    graph.zoomToFit(600, 120)
  }

  /** Where a node is on screen, for debugging and browser tests. */
  function screenPosition(id: string) {
    const n = graph.graphData().nodes.find((g) => g.id === id)
    if (!n || n.x === undefined) return null
    return graph.graph2ScreenCoords(n.x, n.y!, n.z!)
  }

  return { render, fit, flyTo, screenPosition, graph }
}

function disposeObject(obj: object) {
  const o = obj as { geometry?: { dispose(): void }; material?: { dispose(): void; map?: { dispose(): void } | null } }
  o.geometry?.dispose()
  o.material?.map?.dispose()
  o.material?.dispose()
}
