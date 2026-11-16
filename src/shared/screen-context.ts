import { personaNamed } from './personas.js'
import { hiddenScreenIds, knownAs } from './screens.js'
import type { Persona, Screen } from './types.js'

/**
 * What a screen is for and who it is for, as the Comment button shows it in
 * its menu while someone looks at that screen in the running product.
 */
export interface ScreenContext {
  id: string
  title: string
  purpose: string
  personas: { name: string; summary: string; jobs: string[] }[]
}

/** A route as a pattern: `:id`, `{id}`, `[id]` and `[...rest]` match one or more parts, `*` anything. */
function routePattern(route: string): RegExp | null {
  if (!/[:{[*]/.test(route)) return null
  const parts = route
    .replace(/\/+$/, '')
    .split('/')
    .map((p) => {
      if (p === '*' || /^\[\.\.\..+\]$/.test(p) || /^\{.+\*\}$/.test(p)) return '.+'
      if (/^:.+$/.test(p) || /^\{.+\}$/.test(p) || /^\[.+\]$/.test(p)) return '[^/]+'
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
  return new RegExp(`^${parts.join('/')}/?$`, 'i')
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p).toLowerCase()

/**
 * The screen a page of the running product is, by its path: a route in
 * `code:` or a path in `open:` that is the same, else a route whose parameters
 * match (`/visits/:id` for /visits/42), the most specific first. Hidden screens
 * are not part of the product, so they are never the answer.
 */
export function screenForPath(path: string, screens: Screen[]): Screen | null {
  const hidden = hiddenScreenIds(screens)
  const live = screens.filter((s) => !s.error && !hidden.has(s.id))
  const want = trim(path.split(/[?#]/)[0] || '/')
  const routes = (s: Screen) => [...s.open, ...s.code].filter((c) => c.startsWith('/'))
  const exact = live.find((s) => routes(s).some((r) => trim(r) === want))
  if (exact) return exact
  let best: { screen: Screen; fixed: number } | null = null
  for (const s of live) {
    for (const r of routes(s)) {
      const re = routePattern(r)
      if (!re?.test(want)) continue
      // The route with the most fixed parts wins: /visits/new before /visits/:id.
      const fixed = r.split('/').filter((p) => p && !/[:{[*]/.test(p)).length
      if (!best || fixed > best.fixed) best = { screen: s, fixed }
    }
  }
  return best?.screen ?? null
}

/**
 * The screen the app shows, by the name the phone reads (a navigation title,
 * `.grndwrkScreen`, or the view's type like BookingView): its title, `seen_as`
 * or code. A view's type wins over a shared name like App.
 */
export function screenForName(name: string, component: string, screens: Screen[]): Screen | null {
  const hidden = hiddenScreenIds(screens)
  const live = screens.filter((s) => !s.error && !hidden.has(s.id))
  return (component && live.find((s) => knownAs(s, component))) || (name && live.find((s) => knownAs(s, name))) || null
}

/** A section of a persona as lines: numbered or bulleted items, or its paragraphs. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim())
    .filter(Boolean)
}

/** The screen of a path, with its purpose and each persona it is for: name, summary and jobs. */
export function screenContext(path: string, screens: Screen[], personas: Persona[]): ScreenContext | null {
  return contextOf(screenForPath(path, screens), personas)
}

/** The same for a screen already found, like one the phone named. */
export function contextOf(screen: Screen | null, personas: Persona[]): ScreenContext | null {
  if (!screen) return null
  return {
    id: screen.id,
    title: screen.title,
    purpose: screen.purpose,
    personas: screen.audience.map((name) => {
      const p = personaNamed(name, personas)
      return { name: p?.name ?? name, summary: p?.summary ?? '', jobs: p ? lines(p.jobs ?? '').slice(0, 6) : [] }
    }),
  }
}
