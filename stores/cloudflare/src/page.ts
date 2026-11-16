/**
 * The page at each project's address (`/<project>/`), and the Comment button
 * for the staging site, from the folder `grndwrk store assets page` writes
 * next to wrangler.toml. Cloudflare serves that folder as the Worker's static
 * assets (`[assets]` in wrangler.toml, binding ASSETS, the Worker first), so
 * nothing is copied into the code: this file picks the names, sets the
 * headers, and puts store.js together. The rules of grndwrk's
 * src/shared-store/page.ts, copied so this folder deploys on its own. Keep them the same.
 */

export interface Assets {
  fetch(req: Request): Promise<Response>
}

const PAGE_FILE = /^(?:index\.html|assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:js|css|woff2|svg|png))$/
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' }
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'"

const headers = (name: string) => ({
  'Content-Type': TYPES[/\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''] ?? 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
})

/**
 * A GET under `/<project>` that is not the protocol: the page, or the button
 * for a page on one of `sites` (by Referer). Null when it is neither.
 */
export async function page(req: Request, assets: Assets | undefined, project: string, sites: string[]): Promise<Response | null> {
  if (!assets || (req.method !== 'GET' && req.method !== 'HEAD')) return null
  const url = new URL(req.url)
  const rest = url.pathname.slice(project.length + 1)
  if (rest === '') return new Response(null, { status: 301, headers: { Location: `${project}/` } })
  const name = rest === '/' ? 'index.html' : rest.slice(1)
  const read = async (n: string) => {
    // html_handling = "none" in wrangler.toml: each file by its own name, no redirects.
    const res = await assets.fetch(new Request(new URL(`/${n}`, url)))
    return res.ok ? res.text() : null
  }
  if (PAGE_FILE.test(name)) {
    const res = await assets.fetch(new Request(new URL(`/${name}`, url)))
    return res.ok ? new Response(req.method === 'HEAD' ? null : res.body, { status: 200, headers: headers(name) }) : null
  }
  if (name !== 'store.js' && name !== 'screenshot.js') return null
  let site = ''
  try {
    site = new URL(req.headers.get('referer') ?? '').origin
  } catch {}
  if (!sites.includes(site)) return new Response('Only for the staging site', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
  const both = { ...headers(name), Vary: 'Referer' }
  if (name === 'screenshot.js') {
    const js = await read(name)
    return js === null ? null : new Response(js, { headers: both })
  }
  const [store, feedback] = await Promise.all([read('overlay/store.js'), read('overlay/feedback.js')])
  if (store === null || feedback === null) return null
  // One script: its config (the project's address, the site), the store mode, then the button.
  const config = { url: `${url.origin}/${project}/`, site }
  return new Response(`window.__grndwrkStoreConfig = ${JSON.stringify(config)};\n${store}\n${feedback}\n`, { headers: both })
}
