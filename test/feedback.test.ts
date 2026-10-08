import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store/nodes.js'
import { NodeSync } from '../src/server/events.js'
import { createFeedback, importFeedback, parseFeedback, storiesFor } from '../src/server/feedback.js'
import { createProxy, inject } from '../src/server/proxy.js'

let gw: string
let store: NodeStore
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-fb-'))
  for (const d of ['nodes', 'stories', 'readiness', 'outputs']) await mkdir(join(gw, d))
  store = new NodeStore(gw)
})
afterEach(() => rm(gw, { recursive: true, force: true }))

const story = `---\nid: s_k3f9\ntitle: Book a desk\nstatus: partial\nfrom: [n_aaaa]\napplies_to: [/booking, App/Views/BookingView.swift]\n---\nAs someone...\n`
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('feedback', () => {
  it('needs text', () => {
    expect(() => parseFeedback({ text: '  ' })).toThrow()
  })

  it('becomes a thought on the Feedback page, in the topic of its screen, with its stories', async () => {
    await writeFile(join(gw, 'stories', 's_k3f9.md'), story)
    const node = await createFeedback(gw, store, parseFeedback({
      text: 'The Book button should say Book desk',
      platform: 'iOS',
      screen: 'BookingView',
      element: { label: 'Book', role: 'Button', id: 'book-button', component: 'BookingView' },
      image: `data:image/png;base64,${PNG}`,
    }))
    expect(node).toMatchObject({ title: 'The Book button should say Book desk', page: 'Feedback', topic: 'BookingView', status: 'open', altitude: 1 })
    expect(node.extra).toMatchObject({ source: 'app', seen_in: ['BookingView', '#book-button', 'BookingView'] })
    expect(node.body).toContain('Comment on the button "Book" (#book-button) on BookingView (iOS).')
    expect(node.body).toContain('Stories for this screen: s_k3f9 (Book a desk)')
    expect(node.body).toMatch(/!\[\]\(\.\.\/files\/n_[a-z0-9]{4}\/\d+\.png\)/)
    expect(await readdir(join(gw, 'files', node.id))).toHaveLength(1)
  })

  it('imports a shared file once, even when the same comment was also sent', async () => {
    const comment = { text: 'Bigger tap target', platform: 'iOS', screen: 'Settings', written: '2026-10-07T09:30:00Z', image: PNG }
    await createFeedback(gw, store, parseFeedback(comment))
    const file = JSON.stringify({ groundwork: 'feedback', comments: [comment, { ...comment, text: 'Second one' }, { text: '' }] })
    expect(await importFeedback(gw, store, file)).toEqual({ added: 1, skipped: 2 })
    const titles = (await store.list()).map((n) => n.title).sort()
    expect(titles).toEqual(['Bigger tap target', 'Second one'])
    const later = (await store.list()).find((n) => n.title === 'Second one')!
    expect(later.body).toContain('Written 2026-10-07 09:30 UTC, sent later.')
  })

  it('matches stories by route or by file name', () => {
    const s = [{ id: 's_1', applies_to: ['/booking'] }, { id: 's_2', applies_to: ['src/pages/Settings.tsx'] }] as never
    expect(storiesFor(s, '/booking').map((x: { id: string }) => x.id)).toEqual(['s_1'])
    expect(storiesFor(s, '/profile', 'Settings').map((x: { id: string }) => x.id)).toEqual(['s_2'])
    expect(storiesFor(s, '/other')).toEqual([])
  })
})

describe('proxy', () => {
  const servers: Server[] = []
  afterEach(() => servers.forEach((s) => s.close()))
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

  it('adds the overlay to pages once', () => {
    const page = inject('<html><body><p>hi</p></body></html>')
    expect(page).toBe('<html><body><p>hi</p><script src="/__groundwork/feedback.js" defer></script></body></html>')
    expect(inject(page)).toBe(page)
  })

  it('passes the product through, adds the overlay to html, and takes comments', async () => {
    const app = createServer((req, res) => {
      if (req.url === '/app.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('console.log(1)')
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>hi</body></html>')
    })
    const appPort = await listen(app)
    const proxy = createProxy({ target: new URL(`http://localhost:${appPort}`), gwDir: gw, store, nodes: new NodeSync(() => store.list()) })
    servers.push(app, proxy)
    const base = `http://localhost:${await listen(proxy)}`

    const page = await (await fetch(`${base}/`)).text()
    expect(page).toContain('<script src="/__groundwork/feedback.js" defer></script></body>')
    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)')
    expect(await (await fetch(`${base}/__groundwork/feedback.js`)).text()).toContain('__groundworkFeedback')

    const res = await fetch(`${base}/__groundwork/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Too much padding here', screen: '/booking', element: { role: 'button', label: 'Book' } }),
    })
    expect(res.status).toBe(201)
    const [node] = await store.list()
    expect(node).toMatchObject({ title: 'Too much padding here', page: 'Feedback', topic: 'booking' })
    expect(node.body).toContain('(Web)')

    // A plain form post from another site cannot write.
    expect((await fetch(`${base}/__groundwork/feedback`, { method: 'POST', body: 'text=x' })).status).toBe(415)
  })
})
