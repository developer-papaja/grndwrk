/**
 * Questions the person cannot answer themselves, marked as waiting for
 * someone: "Waiting for an answer from Person 1", or just "Waiting for an
 * answer". The person then goes through one person's questions with them.
 *
 * Each mark is a small file of its own, `.grndwrk/waiting/<owner>-<key>.json`,
 * so the question's own entry file is never rewritten and two people marking
 * different questions never conflict in git:
 *
 *   { "on": "n_k2m4ab", "question": "Which day do bookings open?", "since": "2026-11-09", "for": "Person 1" }
 *
 * `for` is written only when project.md says `personal_info: yes`. Otherwise
 * the name stays on this Mac (grndwrk's per-user folder) and the file says
 * only that the question waits for an answer.
 */

/** What a question's first line reads as, for matching: case and punctuation do not count. */
const plain = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** The first line of a question, which names it in its file. */
export const questionLine = (question: string) => question.split('\n').find((l) => l.trim())?.trim() ?? question.trim()

/** A short, stable key for one question on one card, screen or persona: the owner and a hash of its first line. */
export function waitingKey(owner: string, question: string): string {
  let h = 0x811c9dc5
  for (const ch of plain(questionLine(question))) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${owner}-${h.toString(16).padStart(8, '0')}`
}

/** One question marked as waiting. Without `for`, it waits for an answer from someone not named. */
export interface Waiting {
  key: string
  on: string
  question: string
  since: string
  for?: string
}

/** Whether the map may hold people's names: yes, no, or not said yet (null, and names stay on this Mac). */
export type PersonalInfo = 'yes' | 'no' | null

export function personalInfo(project: Record<string, unknown>): PersonalInfo {
  const v = project.personal_info
  if (v === true || String(v ?? '').trim().toLowerCase() === 'yes') return 'yes'
  if (v === false || String(v ?? '').trim().toLowerCase() === 'no') return 'no'
  return null
}

/** A person's name as typed: no control characters, one line, at most 60 characters. */
export const cleanName = (name: string) => name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60)
