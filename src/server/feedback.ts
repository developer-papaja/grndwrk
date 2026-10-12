import { BadInput, type NodeStore } from '../store/nodes.js'
import { removeFiles, saveImage } from '../store/files.js'
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
  /**
   * A random key the device made for this comment. It lets the same device
   * delete the comment or ask what became of it later, and nobody else.
   */
  key?: string
  /** The person chose to write the comment on the Mac: no text yet, open it there. */
  onMac?: boolean
}

const short = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '')

export function parseFeedback(body: unknown): FeedbackInput {
  if (!body || typeof body !== 'object') throw new BadInput('Send a comment')
  const b = body as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  const onMac = b.on_mac === true
  if (!text && !onMac) throw new BadInput('A comment needs some text')
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
    key: validKey(b.key),
    onMac: onMac || undefined,
  }
}

const validKey = (k: unknown) => (typeof k === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(k) ? k : undefined)

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
  const where = input.screen ? ` on ${input.screen}` : ''
  // Written on the Mac: the title says what it is about until the person types over it.
  const firstLine = input.text ? input.text.split('\n')[0] : `Comment on ${describeElement(e)}${where}`
  const title = firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine
  // The same comment twice, say sent and then also imported from a shared file: keep the first.
  if (input.key) {
    const same = (await store.list()).find((n) => n.extra?.key === input.key)
    if (same) return same
  } else if (input.written) {
    const same = (await store.list()).find((n) => n.extra?.written === input.written && n.title === title)
    if (same) return same
  }
  const lines = [`Comment on ${describeElement(e)}${where}${input.platform ? ` (${input.platform})` : ''}.`]
  if (input.text && input.text !== title) lines.push('', input.text)
  if (input.onMac) lines.push('', 'Pointed out on the phone, to be written here.')
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
    {
      source: 'app',
      ...(seenIn.length ? { seen_in: seenIn } : {}),
      ...(input.written ? { written: input.written } : {}),
      ...(input.key ? { key: input.key } : {}),
    },
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

/** A comment the device asks about, by the id it got and the device's key. */
interface Ask {
  id: string
  key: string
}

function asks(body: unknown): Ask[] {
  const list = (body as { comments?: unknown })?.comments
  if (!Array.isArray(list)) throw new BadInput('Send { comments: [{ id, key }] }')
  return list
    .slice(0, 500)
    .map((c) => ({ id: typeof c?.id === 'string' ? c.id : '', key: validKey(c?.key) ?? '' }))
    .filter((c) => c.id && c.key)
}

/**
 * What became of comments a device sent: their title and status now, or
 * gone when someone deleted them. Only comments whose key matches are told.
 */
export async function feedbackStatus(store: NodeStore, body: unknown): Promise<{ id: string; title?: string; status?: string; gone?: true }[]> {
  const nodes = new Map((await store.list()).map((n) => [n.id, n]))
  return asks(body).map(({ id, key }) => {
    const n = nodes.get(id)
    if (!n || n.extra?.key !== key) return { id, gone: true as const }
    return { id, title: n.title, status: n.status }
  })
}

/** Delete comments the device sent, when it still holds their keys. Returns the ids deleted. */
export async function removeFeedback(gwDir: string, store: NodeStore, body: unknown): Promise<string[]> {
  const nodes = new Map((await store.list()).map((n) => [n.id, n]))
  const done: string[] = []
  for (const { id, key } of asks(body)) {
    const n = nodes.get(id)
    if (!n || n.extra?.source !== 'app' || n.extra?.key !== key) continue
    await store.delete(id)
    await removeFiles(gwDir, id)
    done.push(id)
  }
  return done
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
