import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../root.js'

/**
 * The page a store serves at each project's address (`<store>/<project>/`):
 * grndwrk's map built to talk to the store from the browser (dist/page, from
 * `vite build --mode page`), and next to it the Comment button for a staging
 * site (feedback.js, store.js) and what draws its pictures (screenshot.js).
 * `grndwrk store assets <dir>` writes them all into one folder; each example
 * store in stores/ serves that folder with these rules. Keep them the same there.
 */

/** The only names a store serves from the folder, under `/<project>/`. The address itself is index.html. */
export const PAGE_FILE = /^(?:index\.html|feedback\.js|store\.js|screenshot\.js|assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png))$/

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
 * requests to its own address only. Alpine needs 'unsafe-eval' for its
 * expressions; there is no inline script. Never framed by another site.
 */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'"

/** The headers a store sends with one of the page's files. */
export function pageHeaders(name: string): Record<string, string> {
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''
  return {
    'Content-Type': PAGE_TYPES[ext] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': PAGE_CSP,
    'Referrer-Policy': 'no-referrer',
    // The page's own name changes with each build; its scripts and styles carry a hash in theirs.
    'Cache-Control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
}

/** Write everything a store hosts into `dir`: the page, the Comment button and its picture library. Returns the names written. */
export async function writePageAssets(dir: string): Promise<string[]> {
  const page = join(PACKAGE_ROOT, 'dist', 'page')
  const names = await readdir(join(page, 'assets')).catch(() => null)
  if (!names) throw new Error(`The page is not built: ${page} is missing. Run npm run build in grndwrk's repository.`)
  await mkdir(join(dir, 'assets'), { recursive: true })
  // Scripts and styles of an earlier build go: their names change with each build.
  for (const old of await readdir(join(dir, 'assets'))) if (!names.includes(old) && PAGE_FILE.test(`assets/${old}`)) await rm(join(dir, 'assets', old))
  const written: string[] = []
  const copy = async (from: string, name: string) => {
    await copyFile(from, join(dir, name))
    written.push(name)
  }
  await copy(join(page, 'index.html'), 'index.html')
  for (const n of names) if (PAGE_FILE.test(`assets/${n}`)) await copy(join(page, 'assets', n), `assets/${n}`)
  await copy(join(PACKAGE_ROOT, 'overlay', 'feedback.js'), 'feedback.js')
  // The Comment button's store mode, when this grndwrk has it.
  const store = join(PACKAGE_ROOT, 'overlay', 'store.js')
  if (await readFile(store).then(() => true, () => false)) await copy(store, 'store.js')
  // As grndwrk's own server serves it: wrapped, so it neither sees the page's module loader nor leaves a global behind but one.
  const lib = await readFile(join(PACKAGE_ROOT, 'dist', 'vendor', 'modern-screenshot.js'), 'utf8').catch(() => '')
  if (lib) {
    await writeFile(join(dir, 'screenshot.js'), `;(function () { var exports, module, define; var globalThis = {};\n${lib}\n;window.__grndwrkShot = globalThis.modernScreenshot })()\n`)
    written.push('screenshot.js')
    await copyFile(join(PACKAGE_ROOT, 'dist', 'vendor', 'modern-screenshot.LICENSE'), join(dir, 'screenshot.LICENSE.txt')).catch(() => {})
  }
  return written
}
