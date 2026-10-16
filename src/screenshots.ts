import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { OLD_GW_DIR, stateDir } from './root.js'
import { readProject } from './store/project.js'
import { rememberedApp } from './store/local.js'
import { listScreens } from './store/screens.js'
import { saveShot, shotsDir } from './store/shots.js'
import { keepOutOfGit } from './store/gitignore.js'
import { needsExample, openPath } from './shared/screens.js'

export interface ScreenshotOptions {
  /** The product's address, like http://localhost:5173. Defaults to the one --app was given last. */
  app?: string
  /** Open a browser window to log in first, and keep the session for later runs. */
  login?: boolean
  /** Only these screens, by id or title. */
  only?: string[]
}

/**
 * Take a picture of every screen in `.grndwrk/screens/` that has a path to
 * open, in the running product, and keep it in `.grndwrk/shots/web/`.
 * Uses Chrome as installed on this machine, through playwright-core.
 */
export async function takeScreenshots(gwDir: string, options: ScreenshotOptions): Promise<void> {
  const remembered = await rememberedApp(gwDir, (await readProject(gwDir)).data.app)
  const app = (options.app ?? (typeof remembered === 'string' ? remembered : '')).replace(/\/+$/, '')
  if (!/^https?:\/\//.test(app)) {
    throw new Error('Say where the product runs: grndwrk screenshots --app http://localhost:5173')
  }
  // app: in project.md is committed, so anyone with a pull request could set
  // it. Only this machine is opened from it; anywhere else must be said here.
  if (!options.app && !isLocalUrl(app)) {
    throw new Error(`project.md says the product runs at ${app}, which is not this machine. To take pictures there, say so: grndwrk screenshots --app ${app}`)
  }
  const screens = (await listScreens(gwDir)).filter((s) => !s.error)
  if (!screens.length) throw new Error('No screens yet. Run /sitemap in Claude Code first.')
  const wanted = options.only?.map((o) => o.toLowerCase())
  const chosen = wanted?.length ? screens.filter((s) => wanted.includes(s.id.toLowerCase()) || wanted.includes(s.title.toLowerCase())) : screens

  const { chromium } = await import('playwright-core')
  // With Chrome's sandbox on: Playwright turns it off unless asked.
  const launch = (headless: boolean) =>
    chromium.launch({ channel: 'chrome', headless, chromiumSandbox: true }).catch(() => {
      throw new Error('Could not start Chrome. Install Google Chrome, then try again.')
    })

  await mkdir(shotsDir(gwDir), { recursive: true })
  await keepOutOfGit(gwDir, 'shots/')
  // The session, so screens behind a login can be opened. It holds cookies, so
  // it lives outside the project, where neither git nor Claude reads it.
  const session = sessionPath(gwDir)
  await mkdir(join(session, '..'), { recursive: true, mode: 0o700 })

  if (options.login) {
    const browser = await launch(false)
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(app)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('Log in in the Chrome window, then press Enter here. ')
    rl.close()
    await context.storageState({ path: session })
    await chmod(session, 0o600)
    await browser.close()
    console.log(`Kept the session for the next runs in ${session}. It holds the login's cookies: delete it to log out.\n`)
  }

  const browser = await launch(true)
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: existsSync(session) ? session : undefined,
  })
  const page = await context.newPage()
  const skipped: string[] = []
  let taken = 0
  for (const screen of chosen) {
    const path = openPath(screen)
    if (path && RISKY.test(path)) {
      skipped.push(`${screen.title}: ${path} looks like it changes something (log out, delete), so it is not opened`)
      continue
    }
    if (!path) {
      skipped.push(`${screen.title}: ${needsExample(screen) ? 'its route needs a value, like an id; add open: [/booking/42] to the screen, or run /sitemap' : 'no route to open'}`)
      continue
    }
    try {
      await page.goto(app + path, { waitUntil: 'networkidle', timeout: 20_000 })
    } catch {
      // A page that keeps a connection open never goes idle; what loaded so far still makes a picture.
    }
    const landed = new URL(page.url()).pathname
    const moved = landed.replace(/\/+$/, '') !== path.split(/[?#]/)[0].replace(/\/+$/, '')
    await saveShot(gwDir, 'web', screen.id, await page.screenshot())
    taken++
    console.log(`${screen.title}: ${path}${moved ? `, ended at ${landed} (a login? run with --login)` : ''}`)
  }
  await browser.close()
  console.log(`\n${taken} ${taken === 1 ? 'picture' : 'pictures'} in the Sitemap view.`)
  if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`)
}

/** Paths that do something when opened, with a logged in session. Never visited for a picture. */
const RISKY = /(log-?out|sign-?out|delete|remove|destroy|unsubscribe|reset)/i

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** Where the login for this project is kept: in the user's own folder, one per project folder. */
export function sessionPath(gwDir: string): string {
  const name = (dir: string) => join(stateDir(), 'sessions', `${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16)}.json`)
  const path = name(gwDir)
  // The login saved while the folder was still .groundwork, before the rename.
  const old = name(join(gwDir, '..', OLD_GW_DIR))
  if (!existsSync(path) && existsSync(old)) {
    try {
      renameSync(old, path)
    } catch {
      // Log in again.
    }
  }
  return path
}
