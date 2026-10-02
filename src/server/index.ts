import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import sirv from 'sirv'
import { PACKAGE_ROOT } from '../root.js'
import { NodeStore } from '../store/nodes.js'
import { handleApi } from './api.js'
import { NodeSync } from './events.js'
import { watchGroundwork } from './watcher.js'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

export interface StartOptions {
  gwDir: string
  port: number
  dev: boolean
}

export async function startServer({ gwDir, port, dev }: StartOptions): Promise<{ server: Server; url: string }> {
  const store = new NodeStore(gwDir)
  const nodes = new NodeSync(() => store.list())
  await nodes.prime()

  let ui: Middleware = (_req, res) => res.writeHead(404).end()
  const server = createServer(async (req, res) => {
    // Only answer requests addressed to this machine. This blocks DNS rebinding,
    // where another site points its own hostname at 127.0.0.1.
    if (!isLocalHost(req.headers.host)) return res.writeHead(403).end('Forbidden')
    if (await handleApi(req, res, { gwDir, store, nodes })) return
    ui(req, res, () => res.writeHead(404).end())
  })

  if (dev) {
    const { createServer: createVite } = await import('vite')
    const vite = await createVite({
      configFile: join(PACKAGE_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    })
    ui = vite.middlewares
  } else {
    ui = sirv(join(PACKAGE_ROOT, 'dist', 'ui'), { single: true, dev: false })
  }

  const actualPort = await listen(server, port)
  watchGroundwork(gwDir, nodes)
  return { server, url: `http://localhost:${actualPort}` }
}

function isLocalHost(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

/** Listen on `port`, or the next free one if it is taken. */
async function listen(server: Server, port: number, attempts = 20): Promise<number> {
  for (let p = port; p < port + attempts; p++) {
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (err.code === 'EADDRINUSE') resolve(false)
        else reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, '127.0.0.1')
    })
    if (ok) return p
  }
  throw new Error(`No free port between ${port} and ${port + attempts - 1}`)
}
