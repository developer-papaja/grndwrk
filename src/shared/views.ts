import { PROGRESS } from './progress.js'
import { NODE_TYPES } from './types.js'

/**
 * A view of the map saved for everyone on the project: how the map draws its
 * cards and what it filters, under a name. One file each,
 * `.grndwrk/views/<id>.json`, so two people saving views never touch the same
 * file. Applying one sets exactly what View settings and the Filter row set.
 */
export interface SavedView {
  id: string
  name: string
  layout: 'board' | 'outline'
  groupBy: 'page' | 'topic'
  cardGroup: 'level' | 'feature' | 'topic' | 'type'
  filters: ViewFilters
  /** The screen worked on; none is the whole product. */
  part?: string
  /** The page of the map; none is All. */
  page?: string
  created: string
  by?: string
}

export interface ViewFilters {
  /** '' is Open (the default), 'all' Everything, or one status. */
  status: string
  type: string
  /** A topic's key, as the map compares topics (lower case). */
  topic: string
  /** 0 for any level, else 1 to 5. */
  level: number
  who: string
  /** '' every question, 'general' those waiting for anyone, '@<name>' one person's. */
  waiting: string
  new: boolean
}

/** What a view holds besides its id, name and who made it: the part the map can apply. */
export type ViewSettings = Pick<SavedView, 'layout' | 'groupBy' | 'cardGroup' | 'filters' | 'part' | 'page'>

export const VIEW_ID = /^v_[a-z0-9]{6}$/
const LAYOUTS = ['board', 'outline'] as const
const GROUP_BY = ['page', 'topic'] as const
const CARD_GROUPS = ['level', 'feature', 'topic', 'type'] as const
const PART = /^p_[A-Za-z0-9_-]{1,60}$/

/** One line of plain words: no control or format characters, at most `max`. */
export const oneLine = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Why a view's name will not do, or ''. */
export function viewNameProblem(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) return 'A view needs a name'
  if (/[\r\n]/.test(name.trim())) return 'A view\'s name is one line'
  if (name.trim().length > 80) return 'A view\'s name is at most 80 characters'
  return ''
}

const pick = <T extends string>(v: unknown, from: readonly T[], fallback: T): T => (from.includes(v as T) ? (v as T) : fallback)

/** The filters as the map knows them; anything else becomes the default. */
export function cleanFilters(input: unknown): ViewFilters {
  const f = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const status = f.status === 'all' || (PROGRESS as unknown[]).includes(f.status) ? (f.status as string) : ''
  const level = typeof f.level === 'number' && Number.isInteger(f.level) && f.level >= 1 && f.level <= 5 ? f.level : 0
  const waiting = f.waiting === 'general' ? 'general' : typeof f.waiting === 'string' && f.waiting.startsWith('@') ? `@${oneLine(f.waiting.slice(1), 120)}` : ''
  return {
    status,
    type: (NODE_TYPES as readonly unknown[]).includes(f.type) ? (f.type as string) : '',
    topic: oneLine(f.topic, 80).toLowerCase(),
    level,
    who: oneLine(f.who, 120),
    waiting: waiting === '@' ? '' : waiting,
    new: f.new === true,
  }
}

/** A view's settings, only known values; unknown keys are dropped. */
export function cleanSettings(input: unknown): ViewSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const part = typeof o.part === 'string' && PART.test(o.part) ? o.part : ''
  const page = oneLine(o.page, 80)
  return {
    layout: pick(o.layout, LAYOUTS, 'board'),
    groupBy: pick(o.groupBy, GROUP_BY, 'page'),
    cardGroup: pick(o.cardGroup, CARD_GROUPS, 'level'),
    filters: cleanFilters(o.filters),
    ...(part ? { part } : {}),
    ...(page && page !== '*' ? { page } : {}),
  }
}

/** A view file as read: null when it is not one. */
export function readView(id: string, input: unknown): SavedView | null {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Record<string, unknown> | null
  if (!o || !VIEW_ID.test(id) || o.id !== id || viewNameProblem(o.name)) return null
  const by = oneLine(o.by, 120)
  return {
    id,
    name: oneLine(o.name, 80),
    ...cleanSettings(o),
    created: typeof o.created === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.created) ? o.created.slice(0, 10) : '',
    ...(by ? { by } : {}),
  }
}

/** Whether two sets of settings show the same map. */
export function sameSettings(a: ViewSettings, b: ViewSettings): boolean {
  const key = (s: ViewSettings) => JSON.stringify(cleanSettings(s))
  return key(a) === key(b)
}
