import { BadInput, type NodeStore } from '../store/nodes.js'
import { saveImage } from '../store/files.js'
import { listStories } from '../store/stories.js'
import type { GNode, Story } from '../shared/types.js'

/**
 * A comment left on the running product, from the web overlay or the iOS
 * package. It becomes a thought on the Feedback page, in a topic named after
 * the screen, saying what was touched and which stories cover that screen.
 */
export interface FeedbackInput {
  text: string
  /** "Web" or "iOS". */
  platform?: string
  /** A route like /booking, or a screen like BookingView. */
  screen?: string
  element?: {
    /** What a person would call it: its accessibility label, or its text. */
    label?: string
    /** An accessibility identifier, test id or element id. */
    id?: string
    /** Button, link, text field, image... */
    role?: string
    /** The component it belongs to, when the framework says (React, Vue, SwiftUI view). */
    component?: string
    /** A CSS path, for the web. */
    selector?: string
  }
  url?: string
  /** When the comment was written, if it was kept on the device and sent later. ISO date and time. */
  written?: string
  /** A crop around the element, as a data URL or plain base64 PNG or JPEG. */
  image?: string
}

const short = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '')

export function parseFeedback(body: unknown): FeedbackInput {
  if (!body || typeof body !== 'object') throw new BadInput('Send a comment')
  const b = body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) throw new BadInput('A comment needs some text')
  const e = (b.element && typeof b.element === 'object' ? b.element : {}) as Record<string, unknown>
  return {
    text: text.slice(0, 4000),
    platform: short(b.platform, 20) || undefined,
    screen: short(b.screen, 200) || undefined,
    element: {
      label: short(e.label, 200) || undefined,
      id: short(e.id, 200) || undefined,
      role: short(e.role, 60) || undefined,
      component: short(e.component, 120) || undefined,
      selector: short(e.selector, 400) || undefined,
    },
    url: short(b.url, 500) || undefined,
    written: typeof b.written === 'string' && !Number.isNaN(Date.parse(b.written)) ? new Date(b.written).toISOString() : undefined,
    image: typeof b.image === 'string' ? b.image : undefined,
  }
}

/** "the button "Book" (#book-button)" */
export function describeElement(e: FeedbackInput['element'] = {}): string {
  const what = (e.role || 'element').toLowerCase()
  const parts = [`the ${what}${e.label ? ` "${e.label}"` : ''}`]
  if (e.id) parts.push(`(#${e.id})`)
  return parts.join(' ')
}

/** Stories whose applies_to covers the screen or the component. */
export function storiesFor(stories: Story[], screen?: string, component?: string): Story[] {
  const names = [screen, component].filter((n): n is string => !!n).map((n) => n.toLowerCase())
  if (!names.length) return []
  const matches = (entry: string) => {
    const path = entry.toLowerCase()
    const base = path.split('/').pop()?.replace(/\.[a-z]+$/, '') ?? ''
    return names.some((n) => (n.startsWith('/') ? path === n || path.endsWith(n) : base === n || base === n.replace(/view$/, '')))
  }
  return stories.filter((s) => s.applies_to.some(matches))
}

/** The topic a screen's comments gather in: "booking" for /booking, "start page" for /. */
export function topicFor(screen?: string): string {
  if (!screen) return ''
  if (!screen.startsWith('/')) return screen
  const path = screen.replace(/^\/+|\/+$/g, '')
  return path || 'start page'
}

export async function createFeedback(gwDir: string, store: NodeStore, input: FeedbackInput): Promise<GNode> {
  const e = input.element ?? {}
  const firstLine = input.text.split('\n')[0]
  const title = firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine
  // The same comment twice, say sent and then also imported from a shared file: keep the first.
  if (input.written) {
    const same = (await store.list()).find((n) => n.extra?.written === input.written && n.title === title)
    if (same) return same
  }
  const where = input.screen ? ` on ${input.screen}` : ''
  const lines = [`Comment on ${describeElement(e)}${where}${input.platform ? ` (${input.platform})` : ''}.`]
  if (input.text !== title) lines.push('', input.text)
  // Kept on the device while Groundwork was not running: say when it was really written.
  if (input.written && input.written.slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
    lines.push('', `Written ${input.written.slice(0, 16).replace('T', ' ')} UTC, sent later.`)
  }
  const facts = [
    e.component && `Component: ${e.component}`,
    e.selector && `Selector: \`${e.selector}\``,
    input.url && `Address: ${input.url}`,
  ].filter((f): f is string => !!f)
  if (facts.length) lines.push('', ...facts)
  const stories = storiesFor(await listStories(gwDir), input.screen, e.component)
  if (stories.length) lines.push('', `Stories for this screen: ${stories.map((s) => `${s.id} (${s.title})`).join(', ')}`)

  const seenIn = [input.screen, e.id ? `#${e.id}` : e.label, e.component].filter((s): s is string => !!s)
  const change = await store.create(
    { title, type: 'idea', page: 'Feedback', topic: topicFor(input.screen), altitude: 1, status: 'open', body: lines.join('\n') + '\n' },
    { source: 'app', ...(seenIn.length ? { seen_in: seenIn } : {}), ...(input.written ? { written: input.written } : {}) },
  )
  let node = change.upserted[0]

  const image = decodeImage(input.image)
  if (image) {
    try {
      const { markdown } = await saveImage(gwDir, node.id, image.type, image.data)
      node = (await store.update(node.id, { body: `${node.body.replace(/\n+$/, '')}\n\n${markdown}\n` })).upserted[0]
    } catch {
      // The comment matters more than the picture. Keep it without.
    }
  }
  return node
}

/**
 * Comments a tester shared as a file: { groundwork: "feedback", comments: [...] },
 * or a plain list of comments. Returns how many were new.
 */
export async function importFeedback(gwDir: string, store: NodeStore, raw: string): Promise<{ added: number; skipped: number }> {
  const data = JSON.parse(raw)
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.comments) ? data.comments : []
  if (!list.length) throw new BadInput('No comments in this file')
  let added = 0
  let skipped = 0
  for (const item of list) {
    const before = (await store.list()).length
    try {
      await createFeedback(gwDir, store, parseFeedback(item))
    } catch {
      skipped++
      continue
    }
    if ((await store.list()).length > before) added++
    else skipped++
  }
  return { added, skipped }
}

function decodeImage(raw?: string): { type: string; data: Buffer } | null {
  if (!raw) return null
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(raw)
  const type = m ? m[1] : 'image/png'
  const data = Buffer.from(m ? m[2] : raw, 'base64')
  return data.length ? { type, data } : null
}
