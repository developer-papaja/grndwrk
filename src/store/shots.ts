import { mkdir, readdir, readFile, rename, stat, writeFile } from './fs.js'
import { join } from 'node:path'
import { keepOutOfGit } from './gitignore.js'

/**
 * Pictures of the product's screens, in `.groundwork/shots/`, kept out of git
 * since they can show real data:
 * - web/<screen id>.png, taken by `groundwork screenshots`
 * - ios/<view>.jpg, sent by GroundworkFeedback as the app is used; <view> is
 *   the view's type or title, matched to a screen through its code. Screens
 *   without a name of their own (App, ContentView) that look different get a
 *   file each: App.jpg, App-2.jpg. Next to each, <view>.json keeps what the
 *   screen showed (its texts and accessibility identifiers), for /sitemap.
 * A screen can name its pictures in `shots:` (ios/App-2.jpg), which wins over
 * matching by name.
 */
export type ShotPlatform = 'web' | 'ios'

export interface Shot {
  platform: ShotPlatform
  /** The screen id for web, the view's name for iOS (App-2 for the second screen called App). */
  key: string
  /** How a screen names it in `shots:`: ios/App-2.jpg. */
  file: string
  /** What the screen showed, from the app: its texts and accessibility identifiers. */
  texts?: string[]
  /** Where the browser loads it. */
  url: string
  /** When it was taken (ISO). */
  taken: string
}

const EXT: Record<ShotPlatform, string> = { web: '.png', ios: '.jpg' }

export function shotsDir(gwDir: string, platform?: ShotPlatform): string {
  return platform ? join(gwDir, 'shots', platform) : join(gwDir, 'shots')
}

/** File names are the key, encoded, so any view name makes a safe name and reads back. */
const fileOf = (key: string, platform: ShotPlatform) => encodeURIComponent(key).replace(/^\./, '%2E') + EXT[platform]
const keyOf = (file: string, platform: ShotPlatform) => {
  try {
    return file.endsWith(EXT[platform]) ? decodeURIComponent(file.slice(0, -EXT[platform].length)) : null
  } catch {
    return null
  }
}

export async function listShots(gwDir: string): Promise<Shot[]> {
  const out: Shot[] = []
  for (const platform of ['web', 'ios'] as const) {
    const dir = shotsDir(gwDir, platform)
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const key = keyOf(file, platform)
      if (!key) continue
      const taken = (await stat(join(dir, file)).catch(() => null))?.mtime
      if (!taken) continue
      const shot: Shot = { platform, key, file: `${platform}/${key}${EXT[platform]}`, url: `/shots/${platform}/${encodeURIComponent(file)}?v=${taken.getTime()}`, taken: taken.toISOString() }
      if (platform === 'ios') {
        const about = await readAbout(gwDir, key)
        if (about) shot.texts = [...about.texts, ...about.ids]
      }
      out.push(shot)
    }
  }
  return out
}

export async function saveShot(gwDir: string, platform: ShotPlatform, key: string, data: Buffer): Promise<void> {
  const dir = shotsDir(gwDir, platform)
  await mkdir(dir, { recursive: true })
  await keepOutOfGit(gwDir, 'shots/')
  const path = join(dir, fileOf(key, platform))
  const tmp = join(dir, `.${Date.now()}.tmp`)
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/** What the app said the screen showed, kept next to its picture. */
export interface ShotAbout {
  /** The name the app gave the screen: its title, view or App. */
  screen: string
  /** Whether that name is the screen's own (a title or .groundworkScreen). */
  named: boolean
  texts: string[]
  ids: string[]
}

const aboutPath = (gwDir: string, key: string) => join(shotsDir(gwDir, 'ios'), fileOf(key, 'ios').replace(/\.jpg$/, '.json'))

async function readAbout(gwDir: string, key: string): Promise<ShotAbout | null> {
  try {
    const a = JSON.parse(await readFile(aboutPath(gwDir, key), 'utf8'))
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return { screen: String(a.screen ?? key), named: a.named === true, texts: strings(a.texts), ids: strings(a.ids) }
  } catch {
    return null
  }
}

/** Names the app falls back to when a screen has no title: they say nothing about which screen it is. */
const GENERIC_VIEW = /^(app|.*app|contentview|rootview|mainview|appview|tabview|maintabview|homeview|unknown)$/i

/** What a screen shows, comparable: lower case, digits as #, so a clock or a count does not count. */
export function look(about: Pick<ShotAbout, 'texts' | 'ids'>): Set<string> {
  return new Set([...about.texts, ...about.ids].map((t) => t.toLowerCase().replace(/[0-9]+/g, '#')))
}

/** The same screen: at least half of what either shows is shared. Nothing to compare counts as the same. */
export function alike(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return true
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared) >= 0.5
}

/**
 * Keep a picture from the app. A screen with a name of its own replaces its
 * picture. One that only has a fallback name (App, ContentView) replaces the
 * picture that looks like it, or gets a file of its own: App-2, App-3.
 * Returns the key it was kept under.
 */
export async function saveIosShot(gwDir: string, about: ShotAbout, data: Buffer): Promise<string> {
  let key = about.screen
  const comparable = look(about)
  if (!about.named && GENERIC_VIEW.test(about.screen) && comparable.size) {
    const files = await readdir(shotsDir(gwDir, 'ios')).catch(() => [] as string[])
    const same = new RegExp(`^${about.screen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`)
    const siblings = files
      .map((f) => keyOf(f, 'ios'))
      .filter((k): k is string => !!k && same.test(k))
      .sort((a, b) => (Number(a.split('-').pop()) || 1) - (Number(b.split('-').pop()) || 1))
    key = ''
    for (const k of siblings) {
      const before = await readAbout(gwDir, k)
      // A picture from before the app sent its texts could be any of them: replace it.
      if (!before || (!before.texts.length && !before.ids.length) || alike(look(before), comparable)) {
        key = k
        break
      }
    }
    if (!key) {
      const taken = new Set(siblings)
      let n = 1
      while (taken.has(n === 1 ? about.screen : `${about.screen}-${n}`)) n++
      key = n === 1 ? about.screen : `${about.screen}-${n}`
    }
  }
  await saveShot(gwDir, 'ios', key, data)
  await writeFile(aboutPath(gwDir, key), JSON.stringify({ ...about, taken: new Date().toISOString() }, null, 2) + '\n')
  return key
}

/** A shot by the name in its URL. Only files that are in the folder, by their exact name. */
export async function readShot(gwDir: string, platform: string, file: string): Promise<{ data: Buffer; type: string } | null> {
  if (platform !== 'web' && platform !== 'ios') return null
  const dir = shotsDir(gwDir, platform)
  if (!(await readdir(dir).catch(() => [] as string[])).includes(file) || !keyOf(file, platform)) return null
  return { data: await readFile(join(dir, file)), type: platform === 'web' ? 'image/png' : 'image/jpeg' }
}
