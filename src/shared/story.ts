import type { Story } from './types.js'

/**
 * A story's acceptance criteria: the list under its `## Acceptance` heading.
 * `- [x] text` is met, `- [ ] text` is not yet, and a plain `- text` (stories
 * written before criteria could be ticked) counts as not met.
 */
export interface Criterion {
  text: string
  met: boolean
  /** The line in the body, to tick or untick it. */
  line: number
}

export function criteriaOf(body: string): Criterion[] {
  const lines = body.split('\n')
  const out: Criterion[] = []
  let inside = false
  lines.forEach((l, i) => {
    if (/^#{1,6}\s/.test(l)) {
      inside = /^#{1,6}\s+acceptance\b/i.test(l)
      return
    }
    if (!inside) return
    const m = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/.exec(l)
    if (m) out.push({ text: m[2], met: (m[1] ?? ' ').toLowerCase() === 'x', line: i })
  })
  return out
}

/** The body with one criterion ticked or unticked; a plain `- text` gets a box. */
export function tickCriterion(body: string, line: number, met: boolean): string {
  const lines = body.split('\n')
  const l = lines[line]
  if (l === undefined) return body
  const m = /^(\s*[-*]\s+)(?:\[[ xX]\]\s+)?(.*)$/.exec(l)
  if (!m) return body
  lines[line] = `${m[1]}[${met ? 'x' : ' '}] ${m[2]}`
  return lines.join('\n')
}

/** How a story's status reads: "1 of 3 criteria met" when it has criteria, otherwise in words. */
export function storyStatusLabel(story: Pick<Story, 'status' | 'body'>): string {
  if (story.status === 'done') return 'Done'
  const c = criteriaOf(story.body)
  const met = c.filter((x) => x.met).length
  if (story.status === 'partial') return c.length ? `${met} of ${c.length} criteria met` : 'Partially done'
  return met && c.length ? `${met} of ${c.length} criteria met` : 'Not started'
}
