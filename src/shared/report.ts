export type AreaStatus = 'missing' | 'thin' | 'enough'

export interface Area {
  name: string
  status: AreaStatus
  text: string
}

/**
 * Read the checklist areas from a readiness report. /readiness writes each as
 * a paragraph starting with **Name: status.**, where status may be followed
 * by a few words ("missing in the map").
 */
export function parseAreas(body: string): Area[] {
  const areas: Area[] = []
  for (const block of body.split(/\n\s*\n/)) {
    const m = /^\s*\*\*(.+?):\s*(missing|thin|enough)\b([^*]*)\*\*\s*([\s\S]*)$/i.exec(block)
    if (!m) continue
    const extra = m[3].replace(/\.\s*$/, '').trim()
    areas.push({
      name: m[1].trim(),
      status: m[2].toLowerCase() as AreaStatus,
      text: [extra && `(${extra})`, m[4].trim().replace(/\s*\n\s*/g, ' ')].filter(Boolean).join(' '),
    })
  }
  return areas
}
