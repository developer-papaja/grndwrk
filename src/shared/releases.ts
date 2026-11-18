/**
 * Releases, written afterwards: what went out when. A release is a name and a
 * date, whatever the project calls them ("0.4.3", "2.1 (45) on TestFlight",
 * "Sprint 12", "Deployed 2026-11-18"), where it went if that matters, notes,
 * and the ids of what shipped in it: stories, thoughts that were built,
 * comments that were fixed. One file each (`releases/<id>.md`), so two
 * people's releases never conflict, and what shipped is listed in the release,
 * never written into the stories or thoughts themselves.
 */
export interface Release {
  id: string
  name: string
  /** YYYY-MM-DD, or '' when the file has none. */
  date: string
  where: string
  shipped: string[]
  notes: string
  /** Why the file does not read, when it does not. */
  error?: string
}

export const RELEASE_ID = /^r_[a-z0-9]{4,12}$/
const ITEM_ID = /^(?:n|s)_[a-z0-9]{4,12}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const line = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

/** A release from its file's header and notes. Unknown ids and junk are left out, never guessed. */
export function readRelease(id: string, data: Record<string, unknown>, notes: string): Release {
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : line(data.date, 10)
  const shipped = Array.isArray(data.shipped) ? [...new Set(data.shipped.map((s) => line(s, 20)).filter((s) => ITEM_ID.test(s)))] : []
  return { id, name: line(data.name, 80) || id, date: DATE.test(date) ? date : '', where: line(data.where, 80), shipped, notes: notes.trim() }
}

/** Newest first: by date, then by name, so "0.4.10" comes after "0.4.9" on the same day. */
export function sortReleases(list: Release[]): Release[] {
  return [...list].sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name, undefined, { numeric: true }))
}

/** The releases a story or thought shipped in, the first first. */
export function releasesOf(id: string, releases: Release[]): Release[] {
  return sortReleases(releases.filter((r) => r.shipped.includes(id))).reverse()
}

/** "0.4.3 · 2026-11-18", or the name alone. */
export function releaseLabel(r: Release): string {
  return r.date ? `${r.name} · ${r.date}` : r.name
}
