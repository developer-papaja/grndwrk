import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'

/** A folder as `grndwrk store assets` writes it, small, for the stores' tests. */
export const PAGE_FILES: Record<string, string> = {
  'index.html': '<!doctype html><title>grndwrk</title><script type="module" src="./assets/index-abc123.js"></script>',
  'assets/index-abc123.js': 'console.log("page")',
  'overlay/store.js': '/* store mode */',
  'overlay/feedback.js': '/* the button */',
  'screenshot.js': '/* pictures */',
}

export async function writeFakePage(dir: string) {
  for (const [name, text] of Object.entries(PAGE_FILES)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
}

/**
 * What every store must do with the folder (src/shared-store/page.ts): the page
 * at the project's address with its CSP and nosniff, the button only for the
 * staging site, nothing else from the folder. `get` fetches a path under the
 * project's address with an optional Referer.
 */
export async function expectServesPage(get: (path: string, referer?: string) => Promise<Response>, project: string, url: string, site: string) {
  const slashless = await get('')
  expect(slashless.status).toBe(301)
  expect(slashless.headers.get('location')).toBe(`${project}/`)
  const page = await get('/')
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toMatch(/^text\/html/)
  expect(page.headers.get('x-content-type-options')).toBe('nosniff')
  expect(page.headers.get('content-security-policy')).toMatch(/connect-src 'self'/)
  expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/)
  expect(await page.text()).toBe(PAGE_FILES['index.html'])
  const js = await get('/assets/index-abc123.js')
  expect(js.headers.get('content-type')).toMatch(/^text\/javascript/)
  expect(await js.text()).toBe(PAGE_FILES['assets/index-abc123.js'])
  // Only the page's own names: never the folder's other files, nor anything else.
  for (const p of ['/overlay/store.js', '/screenshot.LICENSE.txt', '/assets/x.html', '/package.json']) expect([403, 404, 400]).toContain((await get(p)).status)
  // The button: for the staging site only.
  expect((await get('/store.js')).status).toBe(403)
  expect((await get('/store.js', 'https://elsewhere.example/page')).status).toBe(403)
  const button = await get('/store.js', `${site}/visits/42`)
  expect(button.status).toBe(200)
  expect(button.headers.get('content-type')).toMatch(/^text\/javascript/)
  expect(await button.text()).toBe(`window.__grndwrkStoreConfig = ${JSON.stringify({ url, site })};\n${PAGE_FILES['overlay/store.js']}\n${PAGE_FILES['overlay/feedback.js']}\n`)
  const shot = await get('/screenshot.js', `${site}/`)
  expect(await shot.text()).toBe(PAGE_FILES['screenshot.js'])
}
