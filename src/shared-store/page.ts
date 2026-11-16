import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../root.js'

/**
 * What a store hosts besides the protocol, at each project's address
 * (`<store>/<project>/`), from the folder `grndwrk store assets <dir>` writes:
 *
 *   index.html, assets/...   the page: grndwrk's map built to talk to the store
 *                            from the browser (dist/page, `vite build --mode page`)
 *   overlay/store.js         the Comment button's store mode, and
 *   overlay/feedback.js      the button itself: served together as store.js
 *   screenshot.js            what draws a comment's picture, wrapped as the relay wraps it
 *
 * Each example store in stores/ serves it with these rules (docs/store-protocol.md,
 * The page, and Comments straight to the store). Keep them the same there.
 */

/** The page's own names, served to anyone: it holds no data, and signs in before it reads any. The address itself is index.html. */
export const PAGE_FILE = /^(?:index\.html|assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png))$/

/** The Comment button's names, served only to a page on the staging site (by Referer). */
export const BUTTON_FILES = ['store.js', 'screenshot.js']

export const PAGE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
}

/**
 * Nothing the page shows loads from or talks to another server: its own
 * scripts and styles, pictures it made itself (blob: from the store's bytes),
 * requests to its own address only. Alpine needs for its
 * expressions; there is no inline script. Never framed by another site.
 */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'"

/** The headers a store sends with one of these files. */
export function pageHeaders(name: string): Record<string, string> {
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''
  return {
    'Content-Type': PAGE_TYPES[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': PAGE_CSP,
    'Referrer-Policy': 'no-referrer',
    // The page's scripts and styles carry a hash in their names; everything else is checked each time.
    'Cache-Control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
}

/** store.js as the staging page gets it: its config, the store mode, then the button. */
export function storeScript(config: { url: string; site: string }, storeJs: string, feedbackJs: string): string {
  return `window.__grndwrkStoreConfig = ${JSON.stringify({ url: config.url, site: config.site })};\n${storeJs}\n${feedbackJs}\n`
}

/** The staging site a request for the button comes from: its Referer's origin, when that is one of the sites. */
export function siteOfReferer(referer: string | null | undefined, sites: string[]): string {
  try {
    const origin = new URL(referer ?? '').origin
    return sites.includes(origin) ? origin : ''
  } catch {
    return ''
  }
}

/** Write everything a store hosts into `dir`. Returns the names written. */
export async function writePageAssets(dir: string): Promise<string[]> {
  const page = join(PACKAGE_ROOT, 'dist', 'page')
  const names = await readdir(join(page, 'assets')).catch(() => null)
  if (!names) throw new Error(`The page is not built: ${page} is missing. Run npm run build in grndwrk's repository.`)
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(join(dir, 'overlay'), { recursive: true })
  // Scripts and styles of an earlier build go: their names change with each build.
  for (const old of await readdir(join(dir, 'assets'))) if (!names.includes(old) && PAGE_FILE.test(`assets/${old}`)) await rm(join(dir, 'assets', old))
  const written: string[] = []
  const copy = async (from: string, name: string) => {
    await copyFile(from, join(dir, name))
    written.push(name)
  }
  await copy(join(page, 'index.html'), 'index.html')
  for (const n of names) if (PAGE_FILE.test(`assets/${n}`)) await copy(join(page, 'assets', n), `assets/${n}`)
  await copy(join(PACKAGE_ROOT, 'overlay', 'store.js'), 'overlay/store.js')
  await copy(join(PACKAGE_ROOT, 'overlay', 'feedback.js'), 'overlay/feedback.js')
  // As the relay and grndwrk's own server serve it: wrapped, so it neither sees the page's module loader nor leaves a global behind but one.
  const lib = await readFile(join(PACKAGE_ROOT, 'dist', 'vendor', 'modern-screenshot.js'), 'utf8').catch(() => '')
  if (!lib) throw new Error('dist/vendor/modern-screenshot.js is missing. Run npm run build in grndwrk\'s repository.')
  await writeFile(join(dir, 'screenshot.js'), `;(function () { var exports, module, define; var globalThis = {};\n${lib}\n;window.__grndwrkShot = globalThis.modernScreenshot })()\n`)
  written.push('screenshot.js')
  await copyFile(join(PACKAGE_ROOT, 'dist', 'vendor', 'modern-screenshot.LICENSE'), join(dir, 'screenshot.LICENSE.txt')).catch(() => {})
  return written
}

/**
 * Answer a GET under a project's address from the folder: the page, or the
 * Comment button for a page on one of `sites`. Null when it is none of
 * these, so the request goes on as any other. `rest` is what follows
 * `/<project>`; `url` the project's address.
 */
export async function pageAnswer(dir: string, rest: string, url: string, referer: string | null | undefined, sites: string[]): Promise<{ status: number; headers: Record<string, string>; body: string | Uint8Array } | null> {
  if (rest === '') return { status: 301, headers: { Location: `${url.replace(/\/$/, '').split('/').pop()}/` }, body: '' }
  const name = rest === '/' ? 'index.html' : rest.slice(1)
  const read = (n: string) => readFile(join(dir, n)).catch(() => null)
  if (PAGE_FILE.test(name)) {
    const body = await read(name)
    return body ? { status: 200, headers: pageHeaders(name), body } : null
  }
  if (!BUTTON_FILES.includes(name)) return null
  const site = siteOfReferer(referer, sites)
  if (!site) return { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, body: 'Only for the staging site' }
  const headers = { ...pageHeaders(name), Vary: 'Referer' }
  if (name === 'screenshot.js') {
    const body = await read(name)
    return body ? { status: 200, headers, body } : null
  }
  const [store, feedback] = await Promise.all([read('overlay/store.js'), read('overlay/feedback.js')])
  if (!store || !feedback) return null
  return { status: 200, headers, body: storeScript({ url, site }, store.toString(), feedback.toString()) }
}
