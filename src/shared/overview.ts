import { isFixed } from './feedback.js'
import { progressOfNode } from './progress.js'
import { hiddenScreenIds } from './screens.js'
import { questions, splitBody } from './thread.js'
import type { GNode, Persona, Readiness, Screen, Story } from './types.js'

/**
 * One project's card in All projects, on the page on a team's store: what
 * waits on the person there, worked out from that project's own files the
 * way its map counts them (the Inbox, the red count on Status, the Focus box,
 * the stories, the "N to test" chip).
 */
export interface ProjectOverview {
  /** Open questions for the person: the Inbox's count. */
  questions: number
  /** Blocking gaps nobody answered. */
  blocking: number
  /** The first focus item not set aside. */
  focus: { title: string; why: string } | null
  stories: { done: number; partly: number; all: number }
  /** Fixes and thoughts built and waiting to be tested. */
  toTest: number
}

export interface MapFiles {
  nodes: GNode[]
  screens: Screen[]
  personas: Persona[]
  stories: Story[]
  readiness: Readiness | null
}

export function overviewOf({ nodes, screens, personas, stories, readiness }: MapFiles): ProjectOverview {
  const hidden = hiddenScreenIds(screens)
  const shown = nodes.filter((n) => n.status !== 'principle' && !isFixed(n) && !hidden.has(String(n.extra?.screen ?? '')))
  const open = (body: string) => questions(body).filter((q) => q.open).length
  // A guess from /survey with no question yet is still one thing to confirm, as in the Inbox.
  const guess = (n: GNode) => n.extra?.source === 'inferred' && n.status === 'open' && !splitBody(n.body).entries.some((e) => e.who === 'you')
  const asked =
    shown.reduce((sum, n) => sum + (open(n.body) || (guess(n) ? 1 : 0)), 0) +
    screens.filter((s) => !s.error && !hidden.has(s.id)).reduce((sum, s) => sum + open(s.body), 0) +
    personas.filter((p) => !p.error).reduce((sum, p) => sum + open(p.body), 0)
  const focus = (readiness?.focus ?? []).find((f) => !f.later)
  const valid = stories.filter((s) => !s.error)
  return {
    questions: asked,
    blocking: (readiness?.gaps ?? []).filter((g) => !g.answered_by && g.severity === 'blocking').length,
    focus: focus ? { title: focus.title, why: focus.why } : null,
    stories: { done: valid.filter((s) => s.status === 'done').length, partly: valid.filter((s) => s.status === 'partial' && !s.later).length, all: valid.length },
    toTest: nodes.filter((n) => progressOfNode(n) === 'ready').length,
  }
}

/** A thought that matches a search across projects: its title, and where in its notes the words are. */
export interface ThoughtHit {
  id: string
  title: string
  /** A few words around the match in the notes, or the start of the notes. */
  snippet: string
}

/** Thoughts whose title or notes hold every word searched for, titles first. */
export function searchThoughts(nodes: GNode[], query: string, limit = 20): ThoughtHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: (ThoughtHit & { inTitle: boolean })[] = []
  for (const n of nodes) {
    const notes = splitBody(n.body).notes.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
    const title = n.title.toLowerCase()
    const all = `${title} ${notes.toLowerCase()}`
    if (!words.every((w) => all.includes(w))) continue
    const at = notes.toLowerCase().indexOf(words.find((w) => !title.includes(w)) ?? words[0])
    const from = Math.max(0, at - 40)
    const snippet = at < 0 ? notes.slice(0, 100) : `${from ? '…' : ''}${notes.slice(from, from + 120)}`
    hits.push({ id: n.id, title: n.title, snippet, inTitle: words.every((w) => title.includes(w)) })
  }
  return hits
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ inTitle: _, ...h }) => h)
}
