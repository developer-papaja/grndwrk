import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import { BufferGeometry, Group, Line, LineBasicMaterial, MOUSE, PerspectiveCamera, Sprite, SpriteMaterial, Vector3 } from 'three'
import type { Gap, GNode, NodeType, Status } from '../../src/shared/types'
import { dotTexture, drawCard, drawGhost, ringTexture, SEVERITY_COLORS, type CardState } from './cards'
import {
  ageFractions,
  ageOpacity,
  ALTITUDE_WORDS,
  altitudeStep,
  altitudeY,
  depthZ,
  wrapLabel,
  linkStrength,
  topicColumns,
  topicKey,
  type Column,
} from './layout'
import { SCENE_COLORS, TYPE_COLORS } from './palette'
import { openQuestions } from '../../src/shared/thread'

/** Sideways room between nodes on the same line of a column. */
const ROW_GAP = 80
/** A card with no room shows as a dot this many pixels wide. */
const DOT_PX = 10

interface GraphNode {
  id: string
  title: string
  type: NodeType
  status: Status
  altitude: number
  links: string[]
  topic: string
  error?: string
  /** 0 for the most recently changed node, 1 for the oldest. */
  age: number
  /** Open questions in the node's thread. */
  questions: number
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  /** Height is pinned to altitude and depth to age. Both ease, so changes are visible. */
  fy?: number
  fz?: number
  card?: Sprite
  dot?: Sprite
  cardKey?: string
  cardSize?: { w: number; h: number }
}
interface GraphLink {
  source: string | GraphNode
  target: string | GraphNode
}

export interface SceneView {
  nodes: GNode[]
  selectedId: string | null
  linkMode: boolean
  /** Just added or just pointed at. Shown as a highlighted card for a moment. */
  freshIds: string[]
  /** What /readiness found missing, on the page in view. Drawn as ghost cards. */
  gaps: Gap[]
  selectedGapId: string | null
}

/** A gap drawn in the map. Ghosts are not part of the layout: they sit where their topic and altitude say. */
interface GhostView {
  gap: Gap
  card: Sprite
  dot: Sprite
  key?: string
  size?: { w: number; h: number }
  pos: Vector3
}

/** Where a node can be clicked on screen right now: its card, or its dot. */
type Hit = { id: string; x1: number; x2: number; y1: number; y2: number }

/**
 * Text that keeps the same size on screen at any zoom. Height is a fraction of
 * the view: 0.011 is about 13px on a 900px tall window.
 */
function makeText(text: string, height: number, color: string): SpriteText {
  const t = new SpriteText(text, height, color)
  t.fontFace = 'Inter, system-ui, sans-serif'
  t.fontSize = 48
  t.material.sizeAttenuation = false
  t.material.depthWrite = false
  t.material.transparent = true
  t.raycast = () => {}
  return t
}

/** A sprite that keeps its pixel size and always draws on top of links. */
function screenSprite(order: number): Sprite {
  const sprite = new Sprite(new SpriteMaterial({ sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
  sprite.renderOrder = order
  sprite.raycast = () => {}
  return sprite
}

export function createScene(el: HTMLElement, handlers: { onNodeClick: (id: string) => void; onBackgroundClick: () => void }) {
  let view: SceneView = { nodes: [], selectedId: null, linkMode: false, freshIds: [], gaps: [], selectedGapId: null }
  const ghosts = new Map<string, GhostView>()
  const ghostLayer = new Group()
  let structure = ''
  let layoutKey = ''
  let columns = new Map<string, Column>()
  let hoveredId: string | null = null
  let lastSelected: string | null = null
  let hits: Hit[] = []
  /** Space between altitude levels. Follows the number of columns and the view's shape. */
  let step = 70
  const levelY = (altitude: number) => altitudeY(altitude, step)

  // The constructor type does not carry node and link types, so give them here.
  const graph = (new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<GraphNode, GraphLink>)
    .backgroundColor(SCENE_COLORS.background)
    .showNavInfo(false)
    // Clicks and hover are decided here, from where cards are on screen.
    .enablePointerInteraction(false)
    .enableNodeDrag(false)
    .nodeThreeObject((n) => buildObject(n))
    // Thin lines, never tubes: tubes turn into rods when you zoom in.
    .linkWidth(0)
    .linkOpacity(1)
    .linkColor((l) => linkColor(l))

  // Under 5 pixels of movement while pressed is a click. More is turning the map.
  let down: { x: number; y: number } | null = null
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY }
  })
  el.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 5) return
    const id = pick(e.clientX, e.clientY)
    if (id) handlers.onNodeClick(id)
    else handlers.onBackgroundClick()
  })
  el.addEventListener('pointermove', (e) => {
    if (down) return
    hoveredId = pick(e.clientX, e.clientY)
    el.style.cursor = view.linkMode ? 'crosshair' : hoveredId ? 'pointer' : ''
  })
  el.addEventListener('pointerleave', () => (hoveredId = null))

  /** The card under a screen point, or the nearest dot within reach. */
  function pick(clientX: number, clientY: number): string | null {
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: string | null = null
    let bestDist = Infinity
    for (const h of hits) {
      if (x < h.x1 - 4 || x > h.x2 + 4 || y < h.y1 - 4 || y > h.y2 + 4) continue
      const d = Math.hypot(x - (h.x1 + h.x2) / 2, y - (h.y1 + h.y2) / 2)
      if (d < bestDist) {
        best = h.id
        bestDist = d
      }
    }
    return best
  }

  graph.d3Force('layout', layoutForce())
  graph.d3Force('center', null)

  // Never tip the camera under the map or straight overhead.
  const controls = graph.controls() as { minPolarAngle: number; maxPolarAngle: number; target: Vector3 }
  controls.minPolarAngle = Math.PI * 0.18
  controls.maxPolarAngle = Math.PI * 0.62

  // Frame the map once, shortly after the first nodes arrive. Height, columns
  // and depth are fixed, so the shape is clear long before the layout settles.
  // After that the camera is yours.
  let framed = false
  function frameOnce() {
    if (framed || graph.graphData().nodes.length === 0) return
    framed = true
    setTimeout(fit, 1200)
  }
  graph.cameraPosition({ x: 0, y: 90, z: 460 })
  // The map sits between the side panels, like a canvas in a design tool.
  let insets = { left: 0, right: 0 }
  function setInsets(next: { left: number; right: number }) {
    insets = next
    el.style.left = `${next.left}px`
    el.style.right = `${next.right}px`
    graph.width(window.innerWidth - next.left - next.right).height(window.innerHeight)
  }
  window.addEventListener('resize', () => setInsets(insets))

  /** Hold space to pan with the left button, as in design tools. */
  /** Stop drawing while another view covers the map, and pick up again after. */
  function setActive(on: boolean) {
    if (on) graph.resumeAnimation()
    else graph.pauseAnimation()
  }

  function setPanning(on: boolean) {
    const c = graph.controls() as { mouseButtons: { LEFT: MOUSE } }
    c.mouseButtons.LEFT = on ? MOUSE.PAN : MOUSE.ROTATE
    el.style.cursor = on ? 'grab' : ''
  }

  const guides = new Group()
  const topicLabels = new Group()
  graph.scene().add(guides, topicLabels, ghostLayer)

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
    // The library draws links at render order 10, so cards and dots go above that.
    n.card = screenSprite(21)
    n.dot = screenSprite(20)
    n.dot.visible = false
    group.add(n.card, n.dot)
    n.cardKey = undefined
    style(n)
    return group
  }

  /** Redraw a node's card when something it shows has changed. */
  function style(n: GraphNode) {
    if (!n.card || !n.dot) return
    const state: CardState =
      n.id === view.selectedId
        ? 'selected'
        : view.freshIds.includes(n.id)
          ? 'fresh'
          : view.selectedId && n.links.includes(view.selectedId)
            ? 'linked'
            : 'normal'
    const color = n.error ? SCENE_COLORS.error : TYPE_COLORS[n.type]
    const title = n.error ? `${n.id}.md cannot be read` : n.title
    const key = [title, color, state, n.status, n.questions].join('|')
    if (key === n.cardKey) return
    n.cardKey = key
    const card = drawCard({ title, color, state, settled: n.status === 'settled', error: !!n.error, question: n.questions > 0 })
    const material = n.card.material
    material.map?.dispose()
    material.map = card.texture
    material.needsUpdate = true
    n.cardSize = { w: card.width, h: card.height }
    n.dot.material.map = dotTexture(color)
    n.dot.material.needsUpdate = true
  }

  /** Every frame: ease height and depth toward their targets, and place cards. */
  function frame() {
    for (const n of graph.graphData().nodes) {
      n.fy = ease(n.fy, levelY(n.altitude))
      n.fz = ease(n.fz, depthZ(n.age))
    }
    placeGhosts()
    placeCards()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  function ease(current: number | undefined, target: number): number {
    if (current === undefined || Math.abs(current - target) < 0.1) return target
    return current + (target - current) * 0.12
  }

  /**
   * Cards keep their size on screen. A card that would cover one already shown
   * becomes a dot until there is room: the selected node, its links and the
   * hovered node go first, then the most recent, then higher altitudes.
   */
  function placeCards() {
    const camera = graph.camera() as PerspectiveCamera
    const pxPerUnit = el.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360))
    const isFocus = (n: GraphNode) =>
      n.id === view.selectedId ||
      n.id === hoveredId ||
      view.freshIds.includes(n.id) ||
      n.questions > 0 ||
      (!!view.selectedId && n.links.includes(view.selectedId))
    const nodes = graph
      .graphData()
      .nodes.filter((n) => n.card && n.cardSize && n.x !== undefined)
      .sort((a, b) => Number(isFocus(b)) - Number(isFocus(a)) || a.age - b.age || b.altitude - a.altitude)

    const shown: Hit[] = []
    const dots: Hit[] = []
    for (const n of nodes) {
      const p = graph.graph2ScreenCoords(n.x!, n.y!, n.z!)
      const { w, h } = n.cardSize!
      const box = { id: n.id, x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y - h / 2, y2: p.y + h / 2 }
      const covered = shown.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)
      const asCard = isFocus(n) || !covered
      const opacity = isFocus(n) ? 1 : ageOpacity(n.age) * (n.status === 'parked' ? 0.45 : 1)

      n.card!.visible = asCard
      n.dot!.visible = !asCard
      if (asCard) {
        n.card!.scale.set(w / pxPerUnit, h / pxPerUnit, 1)
        n.card!.material.opacity = opacity
        shown.push(box)
      } else {
        n.dot!.scale.set(DOT_PX / pxPerUnit, DOT_PX / pxPerUnit, 1)
        n.dot!.material.opacity = opacity
        dots.push({ id: n.id, x1: p.x - 8, x2: p.x + 8, y1: p.y - 8, y2: p.y + 8 })
      }
    }
    // Ghosts come after every real card, so they never push one aside.
    const ghostHits: Hit[] = []
    for (const g of ghosts.values()) {
      if (!g.size) continue
      const p = graph.graph2ScreenCoords(g.pos.x, g.pos.y, g.pos.z)
      const { w, h } = g.size
      const box = { id: `gap:${g.gap.id}`, x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y - h / 2, y2: p.y + h / 2 }
      const selected = g.gap.id === view.selectedGapId
      const hovered = hoveredId === box.id
      // A blocking gap always shows in full: it is the thing to see first.
      const blocking = g.gap.severity === 'blocking' && !g.gap.answered_by
      const covered = shown.some((b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)
      const asCard = selected || hovered || blocking || !covered
      g.card.visible = asCard
      g.dot.visible = !asCard
      if (asCard) {
        g.card.scale.set(w / pxPerUnit, h / pxPerUnit, 1)
        shown.push(box)
        ghostHits.push(box)
      } else {
        g.dot.scale.set((DOT_PX + 4) / pxPerUnit, (DOT_PX + 4) / pxPerUnit, 1)
        ghostHits.push({ id: box.id, x1: p.x - 8, x2: p.x + 8, y1: p.y - 8, y2: p.y + 8 })
      }
    }
    hits = [...shown.filter((b) => !b.id.startsWith('gap:')), ...dots, ...ghostHits]
  }

  /**
   * Put each ghost in its topic's column at its altitude, a little behind the
   * real cards. Without a topic it sits beside the thoughts it is near.
   * Ghosts sharing a spot line up next to each other.
   */
  function placeGhosts() {
    const nodes = new Map(graph.graphData().nodes.map((n) => [n.id, n]))
    const taken = new Map<string, number>()
    for (const g of ghosts.values()) {
      const near = g.gap.near.map((id) => nodes.get(id)).filter((n): n is GraphNode => !!n && n.x !== undefined)
      const col = g.gap.topic ? columns.get(topicKey(g.gap.topic)) : undefined
      const baseX = col ? col.x : near.length ? near.reduce((s, n) => s + n.x!, 0) / near.length + 60 : 0
      const altitude = g.gap.altitude ?? 3
      const spot = `${Math.round(baseX)}:${altitude}`
      const i = taken.get(spot) ?? 0
      taken.set(spot, i + 1)
      g.pos.set(baseX + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 120, levelY(altitude), depthZ(1) - 30)
      g.card.position.copy(g.pos)
      g.dot.position.copy(g.pos)
    }
  }

  function renderGhosts() {
    const keep = new Set(view.gaps.map((g) => g.id))
    for (const [id, g] of ghosts) {
      if (keep.has(id)) continue
      ghostLayer.remove(g.card, g.dot)
      g.card.material.map?.dispose()
      g.card.material.dispose()
      g.dot.material.dispose()
      ghosts.delete(id)
    }
    for (const gap of view.gaps) {
      let g = ghosts.get(gap.id)
      if (!g) {
        g = { gap, card: screenSprite(19), dot: screenSprite(18), pos: new Vector3() }
        g.dot.visible = false
        ghostLayer.add(g.card, g.dot)
        ghosts.set(gap.id, g)
      }
      g.gap = gap
      // A blocking gap draws above the cards: it must never hide behind one.
      g.card.renderOrder = gap.severity === 'blocking' && !gap.answered_by ? 22 : 19
      const selected = gap.id === view.selectedGapId
      const key = [gap.title, gap.severity, !!gap.answered_by, selected].join('|')
      if (key !== g.key) {
        g.key = key
        const card = drawGhost({ title: gap.title, severity: gap.severity, answered: !!gap.answered_by, selected })
        g.card.material.map?.dispose()
        g.card.material.map = card.texture
        g.card.material.needsUpdate = true
        g.size = { w: card.width, h: card.height }
        g.dot.material.map = ringTexture(SEVERITY_COLORS[gap.severity])
        g.dot.material.needsUpdate = true
      }
    }
  }

  function render(next: SceneView) {
    view = next
    const existing = new Map(graph.graphData().nodes.map((n) => [n.id, n]))
    const ids = new Set(next.nodes.map((n) => n.id))
    const ages = ageFractions(next.nodes)
    // A topic only gaps point at still gets a column: that is how an empty area shows.
    columns = topicColumns([...next.nodes, ...next.gaps.filter((g) => g.topic).map((g) => ({ topic: g.topic }))])
    step = altitudeStep(columns.size, el.clientWidth / Math.max(1, el.clientHeight))

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
      g.age = ages.get(n.id) ?? 0
      g.questions = openQuestions(n.body)
      return g
    })

    // Only hand the graph new data when nodes or links were added or removed.
    // That keeps the layout calm while titles are typed.
    const nextStructure = [...ids].sort().join(',') + '#' + [...seen].sort().join(',')
    // A topic change moves a node sideways, so it wakes the layout up. Height
    // and depth are eased every frame and need no layout work.
    const nextLayout = nodes.map((n) => `${n.id}:${n.topic}`).sort().join(',')
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
    renderGhosts()
    graph.linkColor(graph.linkColor())
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

  /** Start a new node next to a node it links to, or in its own column, at its height and depth. */
  function place(n: GNode, existing: Map<string, GraphNode>): GraphNode {
    const g: GraphNode = {
      id: n.id,
      title: n.title,
      type: n.type,
      status: n.status,
      altitude: n.altitude,
      links: n.links,
      topic: topicKey(n.topic),
      age: 0,
      questions: 0,
    }
    const jitter = () => (Math.random() - 0.5) * 30
    const anchor = n.links.map((l) => existing.get(l)).find((a) => a?.x !== undefined)
    // Its own topic's column first; the node it links to only when it has no topic.
    const column = g.topic ? columns.get(g.topic) : undefined
    g.x = (column?.x ?? anchor?.x ?? 0) + jitter()
    g.y = g.fy = levelY(n.altitude)
    g.z = g.fz = depthZ(0)
    return g
  }

  /**
   * Height and depth are pinned (see frame). Sideways, a soft pull draws nodes
   * into their topic's column, and nodes on the same line of a column push
   * apart so their cards have room.
   */
  function layoutForce() {
    let nodes: GraphNode[] = []
    const force = (alpha: number) => {
      for (const n of nodes) {
        const colX = columns.get(n.topic)?.x ?? 0
        n.vx = (n.vx ?? 0) + (colX - (n.x ?? 0)) * 0.035 * alpha
      }
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
    const key = step + '#' + [...columns.values()].map((c) => `${c.name}@${c.x}`).join('|')
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
      const y = levelY(a)
      guides.add(new Line(new BufferGeometry().setFromPoints([new Vector3(left, y, 0), new Vector3(right, y, 0)]), material))
      const word = makeText(ALTITUDE_WORDS[a], 0.0095, SCENE_COLORS.guideText)
      // Right aligned against the start of the line.
      word.center.set(1.05, 0.5)
      word.position.set(left, y, 0)
      guides.add(word)
    }
    for (const col of columns.values()) {
      // Long names wrap, so neighbouring columns never share a line of text.
      const label = makeText(wrapLabel(col.name, 12), 0.014, SCENE_COLORS.topic)
      label.center.set(0.5, 0)
      label.position.set(col.x, levelY(5) + 24, 0)
      topicLabels.add(label)
    }
  }

  /**
   * Ease the camera so the node is in the middle. The angle and the zoom stay
   * as they were, so the map around it stays in view.
   */
  function flyTo(id: string) {
    const n = graph.graphData().nodes.find((g) => g.id === id)
    if (!n || n.x === undefined) return
    const target = new Vector3(n.x, n.y, n.z)
    const offset = graph.camera().position.clone().sub(controls.target)
    const pos = target.clone().add(offset)
    graph.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: target.x, y: target.y, z: target.z }, 600)
  }

  /** Back to the overview: straight on, slightly from above, everything in view. */
  function fit() {
    const nodes = graph.graphData().nodes.filter((n) => n.x !== undefined)
    if (nodes.length === 0) return
    const c = nodes.reduce(
      (sum, n) => ({ x: sum.x + n.x! / nodes.length, y: sum.y + n.y! / nodes.length, z: sum.z + n.z! / nodes.length }),
      { x: 0, y: 0, z: 0 },
    )
    const d = graph.camera().position.distanceTo(new Vector3(c.x, c.y, c.z))
    graph.cameraPosition({ x: c.x, y: c.y + d * 0.18, z: c.z + d }, c, 0)
    requestAnimationFrame(() => graph.zoomToFit(600, 120))
  }

  /** Where a node is on screen, for debugging and browser tests. */
  function screenPosition(id: string) {
    const n = graph.graphData().nodes.find((g) => g.id === id)
    if (!n || n.x === undefined) return null
    return graph.graph2ScreenCoords(n.x, n.y!, n.z!)
  }

  return { render, fit, flyTo, setInsets, setPanning, setActive, screenPosition, graph }
}

function disposeObject(obj: object) {
  const o = obj as { geometry?: { dispose(): void }; material?: { dispose(): void; map?: { dispose(): void } | null } }
  o.geometry?.dispose()
  o.material?.map?.dispose()
  o.material?.dispose()
}
