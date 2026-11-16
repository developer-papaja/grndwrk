import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { picturePath } from '../ui/src/pictures.js'

// The page's build points the store code's file calls at the in-memory map; so does this test.
vi.mock('../src/store/fs.js', async () => await import('../ui/src/page/vfs.js'))
// As the page build does (vite.config.ts): forward slashes in the map kept in memory, on Windows too.
vi.mock('node:path', async () => await import('../ui/src/page/path.js'))

const api = await import('../ui/src/api-store.js')

const PORT = 18600
const base = `http://127.0.0.1:${PORT}/clinic/`

class TabStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

describe('pictures the map may show (pictures.ts)', () => {
  it('takes exactly one picture of a card, screen or persona, as files/<id>/<name>', () => {
    expect(picturePath('../files/n_book01/1794850638334.png')).toBe('files/n_book01/1794850638334.png')
    // A thread entry's own file is one folder deeper.
    expect(picturePath('../../files/p_cal001/shot.jpg')).toBe('files/p_cal001/shot.jpg')
    expect(picturePath('files/pe_coord1/a.jpeg')).toBe('files/pe_coord1/a.jpeg')
    expect(picturePath('/files/n_book01/a.png')).toBe('files/n_book01/a.png')
  })

  it('drops every other path, however it is written', () => {
    for (const bad of [
      'files/../../v1/files/project.md',
      'files/n_book01/../../../v1/hello',
      'files/%2e%2e/%2e%2e/v1/hello.png',
      'files/n_book01/%2e%2e.png',
      'files\\..\\..\\v1\\hello.png',
      'files/n_book01\\a.png',
      './files/n_book01/a.png',
      'files/./n_book01/a.png',
      '../../../files/n_book01/a.png',
      'files/n_book01/sub/a.png',
      'files/n_book01/a.png?x=1',
      'files/n_book01/a.png#x',
      'files/n_book01/.png',
      'files/n_book01/a..png',
      'files/n_book01/a.svg',
      'files/nope/a.png',
      'files//a.png',
      '//evil.example/files/n_book01/a.png',
      'https://evil.example/files/n_book01/a.png',
      'v1/files/project.md',
      '/shots/ios/App-2.jpg',
      ' files/n_book01/a.png',
    ]) {
      expect(picturePath(bad), bad).toBeNull()
    }
  })

  it('takes pictures of screens only where asked (grndwrk on a Mac), one name in their folder', () => {
    expect(picturePath('/shots/ios/App-2.jpg', { shots: true })).toBe('shots/ios/App-2.jpg')
    expect(picturePath('shots/web/p_cal001.png', { shots: true })).toBe('shots/web/p_cal001.png')
    expect(picturePath('/shots/ios/Front%20desk.jpg', { shots: true })).toBe('shots/ios/Front%20desk.jpg')
    for (const bad of ['/shots/ios/%2e%2e', '/shots/ios/%2E%2E%2Fapi.jpg', '/shots/ios/..%2fx.jpg', '/shots/ios/a%5cb.jpg', '/shots/mac/a.png', '/shots/ios/a/b.jpg', '/shots/ios/a.svg']) {
      expect(picturePath(bad, { shots: true }), bad).toBeNull()
    }
  })
})

describe('a sign-in handed over in a link (#token=)', () => {
  let server: Server
  const people: Record<string, { name?: string; role: string }> = {
    'gwt-mine': { name: 'Receptionist', role: 'write' },
    'gwt-sender': { name: 'Vet on duty', role: 'write' },
    'gwt-comment': { role: 'comment' },
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
      const who = people[bearer]
      if (req.url !== '/clinic/v1/hello' || !who) return void res.writeHead(401, { 'Content-Type': 'application/json' }).end('{}')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ protocol: 1, project: 'Clinic', writable: who.role === 'write', role: who.role, ...(who.name ? { name: who.name } : {}) }))
    })
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('reads the token out of the fragment', () => {
    expect(api.takeHanded('#token=gwt-sender')).toBe('gwt-sender')
    expect(api.takeHanded('#open=n_book01&token=gwt%2Dsender')).toBe('gwt-sender')
    expect(api.takeHanded('#open=n_book01')).toBe('')
    expect(api.takeHanded('#token=%E0%A4%A')).toBe('')
  })

  it('asks before taking it, says whose it is, and keeps the sign-in this tab had until the person says yes', async () => {
    const storage = new TabStorage()
    storage.setItem('grndwrk.token:/clinic/', 'gwt-mine')
    api.configure({ base, storage: storage as unknown as Storage })
    expect(await api.signIn('gwt-mine')).toBe('')

    await api.offerHanded('gwt-sender')
    expect(api.session.handed).toEqual({ project: 'Clinic', name: 'Vet on duty', replaces: true })
    // Nothing replaced yet: the kept token and the name signed in are the person's own.
    expect(storage.getItem('grndwrk.token:/clinic/')).toBe('gwt-mine')
    expect(api.session.name).toBe('Receptionist')

    api.declineHanded()
    expect(api.session.handed).toBeNull()
    expect(storage.getItem('grndwrk.token:/clinic/')).toBe('gwt-mine')
    // Declined: saying yes now takes nothing.
    expect(await api.acceptHanded()).toBe('')
    expect(storage.getItem('grndwrk.token:/clinic/')).toBe('gwt-mine')

    await api.offerHanded('gwt-sender')
    expect(await api.acceptHanded()).toBe('')
    expect(storage.getItem('grndwrk.token:/clinic/')).toBe('gwt-sender')
    expect(api.session.name).toBe('Vet on duty')
  })

  it('asks too when no sign-in is kept, and never keeps a token the store does not take', async () => {
    const storage = new TabStorage()
    api.configure({ base, storage: storage as unknown as Storage })
    api.signOut()
    await api.offerHanded('gwt-sender')
    expect(api.session.handed).toMatchObject({ name: 'Vet on duty', replaces: false })
    expect(storage.getItem('grndwrk.token:/clinic/')).toBeNull()
    api.declineHanded()

    await api.offerHanded('gwt-unknown')
    expect(api.session.handed).toBeNull()
    expect(api.session.problem).toMatch(/not taken/)
    await api.offerHanded('gwt-comment')
    expect(api.session.handed).toBeNull()
    expect(api.session.problem).toMatch(/only leave comments/)
    expect(storage.length).toBe(0)
  })
})
