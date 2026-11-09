import * as fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdir, readdir, readFile, rename, rm, writeFile } from './fs.js'
import { readProject, writeFields } from './project.js'
import { today } from './frontmatter.js'
import { stateDir } from '../root.js'
import { cleanName, personalInfo, questionLine, waitingKey, type PersonalInfo, type Waiting } from '../shared/waiting.js'

/**
 * Questions waiting for someone (see src/shared/waiting.ts). In the map: one
 * file per question in `.grndwrk/waiting/`, and the names people picked from
 * in project.md (`people: [...]`), both only when `personal_info: yes`.
 * Otherwise names stay on this Mac, in grndwrk's per-user folder, keyed by the
 * project's path like the allowed sites, never in the project:
 *
 *   { "/path/to/project/.grndwrk": { "people": ["Person 1"], "for": { "n_k2m4ab-1f2e3d4c": "Person 1" } } }
 */
const FILE = /^((?:n|p|pe)_[A-Za-z0-9_]{1,60})-([0-9a-f]{8})\.json$/

export function waitingFile(): string {
  // For tests, so they never touch the person's own names.
  if (process.env.GRNDWRK_WAITING_FILE) return process.env.GRNDWRK_WAITING_FILE
  return join(stateDir(), 'waiting.json')
}

interface Local {
  people: string[]
  for: Record<string, string>
}
type LocalFile = Record<string, Local>

async function readLocalFile(file: string): Promise<LocalFile> {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: LocalFile = {}
    for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const { people, for: names } = v as Record<string, unknown>
      out[key] = {
        people: Array.isArray(people) ? people.filter((p): p is string => typeof p === 'string').map(cleanName).filter(Boolean) : [],
        for: Object.fromEntries(Object.entries(names && typeof names === 'object' ? names : {}).filter(([, n]) => typeof n === 'string' && cleanName(n)).map(([k, n]) => [k, cleanName(n as string)])),
      }
    }
    return out
  } catch {
    return {}
  }
}

async function readLocal(gwDir: string, file: string): Promise<Local> {
  return (await readLocalFile(file))[resolve(gwDir)] ?? { people: [], for: {} }
}

async function writeLocal(gwDir: string, file: string, local: Local): Promise<void> {
  const all = await readLocalFile(file)
  // Nothing to change, nothing written: a project that never named anyone leaves no trace here.
  const before = JSON.stringify(all[resolve(gwDir)] ?? { people: [], for: {} })
  if (before === JSON.stringify(local)) return
  if (!local.people.length && !Object.keys(local.for).length) delete all[resolve(gwDir)]
  else all[resolve(gwDir)] = local
  await fsp.mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  await fsp.rename(tmp, file)
}

const folder = (gwDir: string) => join(gwDir, 'waiting')

/** The marks in the map, as their files say. A file that cannot be read is left out. */
async function readMarks(gwDir: string): Promise<Waiting[]> {
  const files = (await readdir(folder(gwDir)).catch(() => [] as string[])).filter((f) => FILE.test(f)).sort()
  const out: Waiting[] = []
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(join(folder(gwDir), f), 'utf8'))
      if (!data || typeof data !== 'object') continue
      const on = FILE.exec(f)![1]
      const w: Waiting = { key: f.slice(0, -'.json'.length), on, question: String(data.question ?? ''), since: String(data.since ?? '') }
      const name = typeof data.for === 'string' ? cleanName(data.for) : ''
      if (name) w.for = name
      out.push(w)
    } catch {
      // Unreadable or removed while reading: left out.
    }
  }
  return out
}

async function writeMark(gwDir: string, w: Waiting): Promise<void> {
  const path = join(folder(gwDir), `${w.key}.json`)
  const text = JSON.stringify({ on: w.on, question: w.question, since: w.since, ...(w.for ? { for: w.for } : {}) }, null, 2) + '\n'
  // Only when what it says changed.
  if ((await readFile(path, 'utf8').catch(() => '')) === text) return
  await mkdir(folder(gwDir), { recursive: true })
  const tmp = join(folder(gwDir), `.${w.key}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

const projectPeople = (data: Record<string, unknown>) =>
  (Array.isArray(data.people) ? data.people : []).map((p) => cleanName(String(p ?? ''))).filter(Boolean)

const addName = (list: string[], name: string) => (list.some((p) => p.toLowerCase() === name.toLowerCase()) ? list : [...list, name])

export interface WaitingState {
  personal_info: PersonalInfo
  /** The names to pick from: the map's and this Mac's. */
  people: string[]
  items: Waiting[]
}

/** Every question waiting for someone, with the name from the map or, failing that, from this Mac. */
export async function readWaiting(gwDir: string, file = waitingFile()): Promise<WaitingState> {
  const { data } = await readProject(gwDir)
  const local = await readLocal(gwDir, file)
  const items = (await readMarks(gwDir)).map((w) => (w.for || !local.for[w.key] ? w : { ...w, for: local.for[w.key] }))
  let people = projectPeople(data)
  for (const p of local.people) people = addName(people, p)
  for (const w of items) if (w.for) people = addName(people, w.for)
  return { personal_info: personalInfo(data), people, items }
}

/**
 * Mark a question as waiting for someone (`for` a name), for an answer from
 * anyone (`for` empty or null), or no longer waiting (`clear`).
 */
export async function setWaiting(
  gwDir: string,
  input: { on: string; question: string; for?: string | null; clear?: boolean },
  file = waitingFile(),
): Promise<WaitingState> {
  const key = waitingKey(input.on, input.question)
  const local = await readLocal(gwDir, file)
  const hadLocal = key in local.for
  delete local.for[key]
  if (input.clear) {
    await rm(join(folder(gwDir), `${key}.json`), { force: true })
    if (hadLocal) await writeLocal(gwDir, file, local)
    return readWaiting(gwDir, file)
  }
  const { data } = await readProject(gwDir)
  const inMap = personalInfo(data) === 'yes'
  const name = cleanName(input.for ?? '')
  const before = (await readMarks(gwDir)).find((w) => w.key === key)
  await writeMark(gwDir, { key, on: input.on, question: questionLine(input.question).slice(0, 500), since: before?.since || today(), ...(name && inMap ? { for: name } : {}) })
  if (name && inMap) {
    const people = projectPeople(data)
    const next = addName(people, name)
    if (next.length !== people.length) await writeFields(gwDir, { people: next })
  } else if (name) {
    local.for[key] = name
    local.people = addName(local.people, name)
  }
  if (name && !inMap) await writeLocal(gwDir, file, local)
  else if (hadLocal) await writeLocal(gwDir, file, local)
  return readWaiting(gwDir, file)
}

/**
 * Say whether the map may hold people's names. Names move with the answer:
 * on no, out of the map's files and project.md onto this Mac; on yes, from
 * this Mac into the map.
 */
export async function setPersonalInfo(gwDir: string, value: 'yes' | 'no', file = waitingFile()): Promise<WaitingState> {
  const { data } = await readProject(gwDir)
  const local = await readLocal(gwDir, file)
  const marks = await readMarks(gwDir)
  if (value === 'no') {
    for (const w of marks) {
      if (!w.for) continue
      local.for[w.key] = w.for
      local.people = addName(local.people, w.for)
      const { for: _, ...rest } = w
      await writeMark(gwDir, rest)
    }
    for (const p of projectPeople(data)) local.people = addName(local.people, p)
    await writeFields(gwDir, { personal_info: 'no', people: '' })
    await writeLocal(gwDir, file, local)
  } else {
    let people = projectPeople(data)
    for (const w of marks) {
      const name = w.for ?? local.for[w.key]
      if (name) people = addName(people, name)
      if (!w.for && name) await writeMark(gwDir, { ...w, for: name })
    }
    for (const p of local.people) people = addName(people, p)
    await writeFields(gwDir, { personal_info: 'yes', ...(people.length ? { people: people } : {}) })
    await writeLocal(gwDir, file, { people: [], for: {} })
  }
  return readWaiting(gwDir, file)
}
