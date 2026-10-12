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
    return screen.code.length > 0 && overlaps(screen.code, where)
  })
}
