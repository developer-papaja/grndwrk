import { readdir, readFile, rename, writeFile } from './fs.js'
import { readRun } from './runs.js'
import { join } from 'node:path'
import { readMatter } from './matter.js'
import { DESIGN_ITEMS, FOUNDATION_STATUSES, FOUNDATIONS, SEVERITIES, type DesignCheck, type DesignStatus, type Foundation, type FoundationStatus, type Gap, type Readiness, type Severity, type Verdict } from '../shared/types.js'

const VERDICTS: Verdict[] = ['ready to build', 'ready to prototype', 'not ready']

const dir = (gwDir: string) => join(gwDir, 'readiness')

/** Read the report and the gaps. Missing or broken files never throw. */
export async function readReadiness(gwDir: string): Promise<Readiness> {
  const out: Readiness = { report: null, gaps: [], design: [], foundations: [] }
  try {
    const raw = await readRun(join(dir(gwDir), 'report'), join(dir(gwDir), 'report.md'))
    if (raw === null) throw new Error('No report yet')
    const { data, content } = readMatter(raw)
    const v = String(data.verdict ?? '').trim().toLowerCase()
    const checked = data.checked instanceof Date ? data.checked.toISOString().slice(0, 10) : String(data.checked ?? '')
    const titles = (x: unknown) => (Array.isArray(x) ? x.filter((t) => typeof t === 'string' && t.trim()).map((t: string) => t.trim()) : [])
    out.report = {
      verdict: (VERDICTS as string[]).includes(v) ? (v as Verdict) : null,
      checked,
      body: content,
      closed: titles(data.closed),
      added: titles(data.added),
    }
  } catch {
    // No report yet.
  }
  try {
    out.gaps = parseGaps(await readFile(join(dir(gwDir), 'gaps.json'), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') out.error = `gaps.json could not be read: ${(err as Error).message}`
  }
  // One file per gap, `readiness/gaps/<id>.json`: answering or closing one gap
  // touches only its own file. These win over an older gaps.json with the same id.
  for (const file of (await readdir(join(dir(gwDir), 'gaps')).catch(() => [] as string[])).sort()) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(file)) continue
    try {
      const [gap] = parseGaps(`[${await readFile(join(dir(gwDir), 'gaps', file), 'utf8')}]`)
      if (!gap) continue
      out.gaps = [...out.gaps.filter((g) => g.id !== gap.id), gap]
    } catch (err) {
      out.error = `readiness/gaps/${file} could not be read: ${(err as Error).message}`
    }
  }
  try {
    const raw = await readRun(join(dir(gwDir), 'design'), join(dir(gwDir), 'design.json'))
    if (raw !== null) out.design = parseDesign(raw)
  } catch {
    // No scorecard yet, or a broken one: show none rather than a wrong one.
  }
  try {
    const raw = await readRun(join(dir(gwDir), 'foundations'), join(dir(gwDir), 'foundations.json'))
    if (raw !== null) out.foundations = parseFoundations(raw)
  } catch {
    // Not checked yet, or broken: the Status page says to run /readiness.
  }
  return out
}

/**
 * What the project has and lacks. The standard items keep their order and
 * group; others follow. A bad status reads as missing; a duplicate id is ignored.
 */
export function parseFoundations(raw: string): Foundation[] {
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) return []
  const out: Foundation[] = []
  const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [])
  for (const f of data) {
    if (!f || typeof f.id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(f.id) || out.some((o) => o.id === f.id)) continue
    const known = FOUNDATIONS.find((k) => k.id === f.id)
    const title = typeof f.title === 'string' && f.title.trim() ? f.title.trim() : known?.title
    if (!title) continue
    const status = (FOUNDATION_STATUSES as readonly string[]).includes(f.status) ? (f.status as FoundationStatus) : 'missing'
    const item: Foundation = {
      id: f.id,
      group: known?.group ?? (typeof f.group === 'string' && f.group.trim() ? f.group.trim().toLowerCase() : 'other'),
      title,
      status,
      seen_in: texts(f.seen_in),
      missing: texts(f.missing),
      suggestion: typeof f.suggestion === 'string' ? f.suggestion.trim() : '',
    }
    if (typeof f.draft === 'string' && /^[A-Za-z0-9_.-]{1,80}\.md$/.test(f.draft)) item.draft = f.draft
    // A path in the product, Markdown, without going up or starting at the root of the disk.
    if (typeof f.file === 'string' && /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./ -]{1,160}\.(md|markdown)$/i.test(f.file.trim())) item.file = f.file.trim()
    out.push(item)
  }
  const rank = (id: string) => {
    const i = FOUNDATIONS.findIndex((k) => k.id === id)
    return i < 0 ? FOUNDATIONS.length : i
  }
  return out.sort((a, b) => rank(a.id) - rank(b.id))
}

/**
 * The design scorecard. Items keep the fixed order; when a repo holds more
 * than one app, each platform has its own set, in the order they first
 * appear, with "All" last. Unknown items are dropped, a bad status reads as
 * missing, and a duplicate item for the same platform is ignored.
 */
export function parseDesign(raw: string): DesignCheck[] {
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) return []
  const items = DESIGN_ITEMS as readonly string[]
  const platforms: string[] = []
  const checks: DesignCheck[] = []
  for (const d of data) {
    if (!d || typeof d.item !== 'string') continue
    const item = d.item.trim().toLowerCase()
    if (!items.includes(item)) continue
    const platform = typeof d.platform === 'string' && d.platform.trim() ? d.platform.trim() : undefined
    if (checks.some((c) => c.item === item && c.platform === platform)) continue
    if (platform && !platforms.includes(platform)) platforms.push(platform)
    const status: DesignStatus = ['found', 'partly', 'missing'].includes(d.status) ? d.status : 'missing'
    checks.push({
      ...(platform ? { platform } : {}),
      item,
      status,
      note: typeof d.note === 'string' ? d.note : '',
      seen_in: Array.isArray(d.seen_in) ? d.seen_in.filter((s: unknown) => typeof s === 'string') : [],
    })
  }
  const rank = (p?: string) => (!p ? -1 : p.toLowerCase() === 'all' ? platforms.length : platforms.indexOf(p))
  return checks.sort((a, b) => rank(a.platform) - rank(b.platform) || items.indexOf(a.item) - items.indexOf(b.item))
}

/** Keep what is usable from a gaps file, fill sensible defaults, drop the rest. */
export function parseGaps(raw: string): Gap[] {
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('expected a list of gaps')
  const gaps: Gap[] = []
  for (const g of data) {
    if (!g || typeof g !== 'object' || typeof g.title !== 'string' || !g.title.trim()) continue
    const id = typeof g.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(g.id) ? g.id : `gap_${gaps.length + 1}`
    const severity = (SEVERITIES as readonly string[]).includes(g.severity) ? (g.severity as Severity) : 'important'
    const gap: Gap = {
      id,
      area: typeof g.area === 'string' ? g.area : '',
      title: g.title.trim(),
      why: typeof g.why === 'string' ? g.why : '',
      near: Array.isArray(g.near) ? g.near.filter((n: unknown) => typeof n === 'string') : [],
      severity,
    }
    if (typeof g.page === 'string' && g.page.trim()) gap.page = g.page.trim()
    if (typeof g.topic === 'string' && g.topic.trim()) gap.topic = g.topic.trim()
    const alt = Math.round(Number(g.altitude))
    if (Number.isFinite(alt) && g.altitude != null) gap.altitude = Math.min(5, Math.max(1, alt))
    if (typeof g.screen === 'string' && /^p_[A-Za-z0-9_-]{1,60}$/.test(g.screen)) gap.screen = g.screen
    if (typeof g.answered_by === 'string' && g.answered_by) gap.answered_by = g.answered_by
    if (gap.answered_by && g.enough === true) gap.enough = true
    if (Array.isArray(g.suggestions)) {
      const suggestions = g.suggestions
        .filter((s: unknown) => !!s && typeof (s as { title?: unknown }).title === 'string' && (s as { title: string }).title.trim())
        .map((s: { title: string; why?: unknown }) => ({ title: s.title.trim(), why: typeof s.why === 'string' ? s.why : '' }))
      if (suggestions.length) gap.suggestions = suggestions
    }
    if (!gaps.some((x) => x.id === gap.id)) gaps.push(gap)
  }
  return gaps
}

/**
 * Record which node answered a gap, keeping every other gap and field as
 * written. With enough, the person accepted the gap as it is, for good.
 */
export async function markAnswered(gwDir: string, gapId: string, nodeId: string, enough = false): Promise<boolean> {
  // A gap in its own file: only that file changes.
  if (/^[A-Za-z0-9_-]{1,64}$/.test(gapId)) {
    const own = join(dir(gwDir), 'gaps', `${gapId}.json`)
    const gap = await readFile(own, 'utf8').then((t) => JSON.parse(t), () => null)
    if (gap && typeof gap === 'object' && gap.id === gapId) {
      gap.answered_by = nodeId
      if (enough) gap.enough = true
      else delete gap.enough
      const tmp = join(dir(gwDir), 'gaps', `.${gapId}.json.tmp`)
      await writeFile(tmp, JSON.stringify(gap, null, 2) + '\n', 'utf8')
      await rename(tmp, own)
      return true
    }
  }
  const path = join(dir(gwDir), 'gaps.json')
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(data)) return false
  const gap = data.find((g) => g && g.id === gapId)
  if (!gap) return false
  gap.answered_by = nodeId
  if (enough) gap.enough = true
  else delete gap.enough
  const tmp = join(dir(gwDir), '.gaps.json.tmp')
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
  return true
}
