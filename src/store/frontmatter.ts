import { readMatter } from './matter.js'
import { NODE_TYPES, STATUSES, type GNode, type NodeType, type Status } from '../shared/types.js'

const KNOWN_KEYS = ['id', 'type', 'title', 'topic', 'page', 'altitude', 'links', 'status', 'created'] as const

export const DEFAULTS = {
  type: 'idea' as NodeType,
  altitude: 3,
  status: 'open' as Status,
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Parse a node file. Never throws: a file that cannot be parsed becomes a
 * node with `error` set, so it still shows up and nothing is lost.
 * The id always comes from the filename, since that is how the file is found.
 */
export function parseNode(id: string, raw: string): GNode {
  let data: Record<string, unknown>
  let content: string
  try {
    const parsed = readMatter(raw)
    data = parsed.data ?? {}
    content = parsed.content
  } catch (err) {
    return {
      id,
      type: DEFAULTS.type,
      title: id,
      topic: '',
      page: '',
      altitude: DEFAULTS.altitude,
      links: [],
      status: DEFAULTS.status,
      created: today(),
      body: raw,
      extra: {},
      error: (err instanceof Error ? err.message.split('\n')[0] : String(err)).replace(/:\s*$/, ''),
    }
  }

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    // A bare date like `fixed: 2026-10-13` stays a plain date, not a timestamp.
    if (!(KNOWN_KEYS as readonly string[]).includes(k)) extra[k] = v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : v
  }

  return {
    id,
    type: oneOf(data.type, NODE_TYPES, DEFAULTS.type),
    title: toText(data.title) || id,
    topic: toText(data.topic),
    page: toText(data.page),
    altitude: toAltitude(data.altitude),
    links: toLinks(data.links, id),
    status: oneOf(data.status, STATUSES, DEFAULTS.status),
    created: toDate(data.created),
    body: content,
    extra,
  }
}

export function serializeNode(node: GNode): string {
  const lines = [
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${scalar(node.title)}`,
    ...(node.topic ? [`topic: ${scalar(node.topic)}`] : []),
    // Who set the topic sits next to it, so the pair reads together.
    ...(node.topic && typeof node.extra.topic_by === 'string' ? [`topic_by: ${scalar(node.extra.topic_by)}`] : []),
    ...(node.page ? [`page: ${scalar(node.page)}`] : []),
    `altitude: ${node.altitude}`,
    `links: [${node.links.join(', ')}]`,
    `status: ${node.status}`,
    `created: ${node.created}`,
  ]
  for (const [k, v] of Object.entries(node.extra)) {
    if (k === 'topic_by') continue
    // A plain date stays unquoted, like created; it reads back as the same text.
    const value = typeof v === 'string' ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : scalar(v)) : JSON.stringify(v instanceof Date ? v.toISOString().slice(0, 10) : v)
    lines.push(`${scalar(k)}: ${value}`)
  }
  return `---\n${lines.join('\n')}\n---\n${node.body}`
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function toText(value: unknown): string {
  if (value == null) return ''
  return String(value).trim()
}

export function toAltitude(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || value == null || value === '') return DEFAULTS.altitude
  return Math.min(5, Math.max(1, n))
}

function toLinks(value: unknown, self: string): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const ids = list.map((v) => String(v).trim()).filter((v) => isValidId(v) && v !== self)
  return [...new Set(ids)]
}

function toDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return today()
}

export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/** An item of a one-line `[a, b]` list: quoted also when it holds a character that ends or splits the list. */
export function flowItem(s: string): string {
  const plain = scalar(s)
  return plain === s && /[,\[\]{}#]/.test(s) ? JSON.stringify(s) : plain
}

/** Write a string as a YAML scalar, quoting only when plain style would misparse. */
export function scalar(s: string): string {
  const needsQuotes =
    s === '' ||
    s !== s.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
    /: |:$| #/.test(s) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(s) ||
    /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s) ||
    /^\d{4}-\d{2}-\d{2}/.test(s)
  // JSON escapes C0 controls; YAML's double quotes take the same \u escapes for the rest.
  return needsQuotes ? JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : s
}
