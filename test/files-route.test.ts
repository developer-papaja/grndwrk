import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleFiles } from '../src/server/api.js'

let gw: string
let server: Server
let base: string
beforeEach(async () => {
  gw = await mkdtemp(join(tmpdir(), 'gw-files-'))
  server = createServer(async (req, res) => {
    if (!(await handleFiles(req, res, gw))) res.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise((done) => server.close(done))
  await rm(gw, { recursive: true, force: true })
})

describe('pictures and files served from the map', () => {
  // Found by the security audit of 2026-11-17 (run-4): a bad escape threw and ended the whole map.
  it('answers 404 to a name whose escapes are not valid, and keeps running', async () => {
    for (const path of ['/shots/android/%E0', '/shots/ios/%E0', '/files/%E0/a.png', '/files/n_abcdef/%ZZ']) {
      expect((await fetch(base + path)).status, path).toBe(404)
    }
    expect((await fetch(`${base}/shots/web/p_home.png`)).status).toBe(404)
  })
})
