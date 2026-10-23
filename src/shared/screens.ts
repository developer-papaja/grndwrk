import type { GNode, Screen, Story } from './types.js'

/** Screens as a tree: each one after its parent, indented by depth. A missing parent counts as none. */
export function screenTree(screens: Screen[]): { screen: Screen; depth: number }[] {
  const ids = new Set(screens.map((s) => s.id))
  const children = new Map<string, Screen[]>()
  for (const s of screens) {
    const parent = s.parent && ids.has(s.parent) && s.parent !== s.id ? s.parent : ''
    children.set(parent, [...(children.get(parent) ?? []), s])
  }
  const out: { screen: Screen; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (parent: string, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.title.localeCompare(b.title))) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push({ screen: s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk('', 0)
  // A loop of parents leaves screens unreached: show them at the top level.
  for (const s of screens) if (!seen.has(s.id)) out.push({ screen: s, depth: 0 })
  return out
}

/**
 * Screens the person hid from the sitemap (`hidden:`), and every screen under
 * one: hiding a playground hides what sits in it too.
 */
export function hiddenScreenIds(screens: Screen[]): Set<string> {
  const byId = new Map(screens.map((s) => [s.id, s]))
  const out = new Set<string>()
  for (const s of screens) {
    const seen = new Set<string>()
    for (let at: Screen | undefined = s; at && !seen.has(at.id); at = byId.get(at.parent)) {
      seen.add(at.id)
      if (at.hidden) {
        out.add(s.id)
        break
      }
    }
  }
  return out
}

/** File names that say nothing about which screen they are, like app/booking/page.tsx. */
const GENERIC = new Set(['index', 'page', 'layout', 'route', 'main', 'app', 'view', 'screen', 'content', 'contentview', '+page', 'default'])

/** The names a route or file is known by: "/booking", "bookingview", "booking". */
function names(entry: string): string[] {
  const path = entry.trim().toLowerCase()
  const base = path.split('/').pop()?.replace(/\.[a-z]+$/, '') ?? ''
  if (GENERIC.has(base)) return [path]
  return [path, base, base.replace(/(viewcontroller|controller|view|screen|page)$/, '')].filter((n) => n && !GENERIC.has(n))
}

function overlaps(a: string[], b: string[]): boolean {
  const left = new Set(a.flatMap(names))
  return b.some((x) => names(x).some((n) => left.has(n)))
}

/** Stories the screen names, and stories whose applies_to points at its code. */
export function storiesForScreen(screen: Screen, stories: Story[]): Story[] {
  return stories.filter((st) => screen.stories.includes(st.id) || (screen.code.length > 0 && overlaps(screen.code, st.applies_to)))
}

/** Comments made in the running product on this screen: in its topic, or seen in its code. */
export function commentsForScreen(screen: Screen, nodes: GNode[]): GNode[] {
  const title = screen.title.trim().toLowerCase()
  return nodes.filter((n) => {
    if (n.extra?.source !== 'app') return false
    if (n.topic.trim().toLowerCase() === title) return true
    const seen = n.extra.seen_in
    const where = Array.isArray(seen) ? seen.map(String) : typeof seen === 'string' ? [seen] : []
    return known(screen).length > 0 && overlaps(known(screen), where)
  })
}

/** Everything a screen is known by in the running product: its code, and the names the app shows. */
function known(screen: Screen): string[] {
  return [...screen.code, ...(screen.seen_as ?? [])]
}

/**
 * A path that opens the screen in the running product: the first of open:,
 * or else the first route in code: without parameters (no :id, [id] or *).
 */
export function openPath(screen: Screen): string {
  return screen.open[0] ?? screen.code.find((c) => c.startsWith('/') && !/[:[*]/.test(c)) ?? ''
}

/** Routes in code: that need a value to open, like /booking/:id, when open: gives none. */
export function needsExample(screen: Screen): boolean {
  return !screen.open.length && screen.code.some((c) => c.startsWith('/') && /[:[*]/.test(c))
}

/**
 * Pictures of the screen. The ones its `shots:` names, first. Then, of the
 * pictures no screen names: the web one by its id, iOS ones by a view named
 * in its code or seen_as, or by its title. Pass every screen so a picture
 * another screen claims is not matched here by name too.
 */
export function shotsForScreen<T extends { platform: string; key: string; file?: string }>(screen: Screen, shots: T[], screens: Screen[] = [screen]): T[] {
  const claimed = new Set(screens.flatMap((s) => s.shots ?? []))
  const own = new Set(screen.shots ?? [])
  const title = screen.title.trim().toLowerCase()
  const named = shots.filter((s) => s.file && own.has(s.file))
  const matched = shots.filter(
    (s) =>
      !(s.file && claimed.has(s.file)) &&
      (s.platform === 'web' ? s.key === screen.id : s.key.trim().toLowerCase() === title || (known(screen).length > 0 && overlaps(known(screen), [s.key]))),
  )
  return [...named, ...matched]
}

export interface SitemapBox {
  id: string
  x: number
  y: number
  depth: number
}

export interface SitemapLayout {
  boxes: SitemapBox[]
  /** Parent to child, as drawn in the tree. The root is ''. */
  edges: { from: string; to: string }[]
  width: number
  height: number
}

export const BOX = { width: 200, height: 96, gapX: 28, gapY: 64 }

/**
 * The screens drawn as a site map, top down: the product at the top, then
 * each screen under its parent. Leaves sit side by side, and a parent is
 * centered over its children. The root box has the id ''.
 */
export function layoutSitemap(screens: Screen[]): SitemapLayout {
  const rows = screenTree(screens)
  // The tree as screenTree resolved it: each row's parent is the nearest row above at one less depth.
  const parentOf = new Map<string, string>()
  const children = new Map<string, string[]>([['', []]])
  const stack: string[] = []
  for (const { screen, depth } of rows) {
    stack.length = depth
    const parent = depth ? stack[depth - 1] : ''
    parentOf.set(screen.id, parent)
    children.set(parent, [...(children.get(parent) ?? []), screen.id])
    children.set(screen.id, children.get(screen.id) ?? [])
    stack.push(screen.id)
  }
  const slot = BOX.width + BOX.gapX
  const level = BOX.height + BOX.gapY
  const boxes = new Map<string, SitemapBox>()
  let next = 0
  const place = (id: string, depth: number): number => {
    const kids = children.get(id) ?? []
    const xs = kids.map((k) => place(k, depth + 1))
    const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : next++ * slot
    boxes.set(id, { id, x, y: depth * level, depth })
    return x
  }
  place('', 0)
  const all = [...boxes.values()]
  return {
    boxes: all,
    edges: [...parentOf.entries()].map(([to, from]) => ({ from, to })),
    width: Math.max(...all.map((b) => b.x)) + BOX.width,
    height: Math.max(...all.map((b) => b.y)) + BOX.height,
  }
}
