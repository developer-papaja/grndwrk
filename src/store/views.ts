import { mkdir, readdir, readFile, rename, unlink, writeFile } from './fs.js'
import { join } from 'node:path'
import { newId } from './nodes.js'
import { today } from './frontmatter.js'
import { cleanSettings, oneLine, readView, type SavedView, VIEW_ID, viewNameProblem } from '../shared/views.js'

/**
 * Views of the map saved for everyone: one JSON file each in `views/`
 * (src/shared/views.ts). Run by grndwrk on the Mac and, over the map in
 * memory, by the page on a store, so both write them the same way.
 */

export class ViewProblem extends Error {}

export async function listViews(gwDir: string): Promise<SavedView[]> {
  const dir = join(gwDir, 'views')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => VIEW_ID.test(f.replace(/\.json$/, '')) && f.endsWith('.json'))
  } catch {
    return []
  }
  const out: SavedView[] = []
  for (const file of files) {
    try {
      const v = readView(file.slice(0, -5), JSON.parse(await readFile(join(dir, file), 'utf8')))
      if (v) out.push(v)
    } catch {
      // A file that is not a view is left alone and not shown.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

const text = (v: SavedView) => `${JSON.stringify(v, null, 2)}\n`

export async function createView(gwDir: string, input: Record<string, unknown>, extra: { by?: string } = {}): Promise<SavedView> {
  const problem = viewNameProblem(input.name)
  if (problem) throw new ViewProblem(problem)
  const dir = join(gwDir, 'views')
  await mkdir(dir, { recursive: true })
  const taken = new Set((await listViews(gwDir)).map((v) => v.id))
  let id: string
  do id = newId('v_')
  while (taken.has(id))
  const by = oneLine(extra.by, 120)
  const view: SavedView = { id, name: oneLine(input.name, 80), ...cleanSettings(input), created: today(), ...(by ? { by } : {}) }
  // Written whole under another name first, so a watcher never reads half a view.
  const tmp = join(dir, `.${id}.json.tmp`)
  await writeFile(tmp, text(view), { flag: 'wx' })
  await rename(tmp, join(dir, `${id}.json`))
  return view
}

/** A new name, new settings, or both. Null when there is no such view. */
export async function updateView(gwDir: string, id: string, input: Record<string, unknown>): Promise<SavedView | null> {
  if (!VIEW_ID.test(id)) return null
  const before = (await listViews(gwDir)).find((v) => v.id === id)
  if (!before) return null
  if (input.name !== undefined) {
    const problem = viewNameProblem(input.name)
    if (problem) throw new ViewProblem(problem)
  }
  const settings = input.settings !== undefined ? cleanSettings(input.settings) : null
  const next: SavedView = {
    id,
    name: input.name !== undefined ? oneLine(input.name, 80) : before.name,
    ...(settings ?? cleanSettings(before)),
    created: before.created || today(),
    ...(before.by ? { by: before.by } : {}),
  }
  // Only when it says something new, so an unchanged view never shows as a change in git or a store.
  if (text(next) !== text(before)) await writeFile(join(gwDir, 'views', `${id}.json`), text(next))
  return next
}

export async function deleteView(gwDir: string, id: string): Promise<boolean> {
  if (!VIEW_ID.test(id)) return false
  try {
    await unlink(join(gwDir, 'views', `${id}.json`))
    return true
  } catch {
    return false
  }
}
