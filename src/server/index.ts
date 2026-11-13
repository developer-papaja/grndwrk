import { connect } from 'node:net'
import { markSuspiciousComments } from './feedback.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import sirv from 'sirv'
import { PACKAGE_ROOT } from '../root.js'
import { NodeStore } from '../store/nodes.js'
import { handleApi, handleFiles } from './api.js'
import { createProxy, handleOverlay, proxyName, type OverlayCtx } from './proxy.js'
import { Sites } from './sites.js'
import { rememberApp } from '../store/local.js'
import { advertise, createLanServer, lanAddresses, pairingCode } from './lan.js'
import { Devices } from './devices.js'
import { readProject, writeFields } from '../store/project.js'
import { broadcast, NodeSync } from './events.js'
import { Pairings } from './pairing.js'
import { handleComments, type CommentsCtx } from './comments.js'
import { watchgrndwrk } from './watcher.js'
import { projectRelay } from '../relay/config.js'
import type { RelaySync } from '../relay/sync.js'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

export interface StartOptions {
  gwDir: string
  port: number
  dev: boolean
  /** The product's dev server. When set, a proxy with the comment overlay runs on appPort. */
  app?: URL
  appPort?: number
  /** Let phones on the same network send comments, on lanPort. */
  lan?: boolean
  lanPort?: number
}

export async function startServer({ gwDir, port, dev, app, appPort, lan, lanPort }: StartOptions): Promise<{ server: Server; url: string; appUrl?: string; lanUrls?: string[]; lanCode?: string; relayUrl?: string }> {
  const store = new NodeStore(gwDir)
  const nodes = new NodeSync(() => store.list())
  await nodes.prime()
  // Comments already in the map, checked with today's check for orders to an agent.
  const marked = await markSuspiciousComments(store).catch(() => [])
  if (marked.length) {
    console.log(`${marked.length === 1 ? 'A comment reads' : `${marked.length} comments read`} like orders to an agent and ${marked.length === 1 ? 'is' : 'are'} now marked suspicious: ${marked.join(', ')}.`)
    await nodes.sync()
  }

  const project = String((await readProject(gwDir)).data.name ?? 'project')
  // Comments from the iOS package: in the Simulator on this port, from a phone on the LAN port.
  const comments: CommentsCtx = { gwDir, store, nodes, project, uiUrl: `http://localhost:${port}` }

  // With --lan: the pairing code to type once, the phones paired so far, and phones asking the person here to allow them.
  const lanCode = lan ? await pairingCode(gwDir) : undefined
  const devices = lanCode ? await new Devices(gwDir).load() : undefined
  const pairings = devices ? new Pairings((name) => devices.add(name), broadcast) : undefined

  // Sites that load the Comment button themselves send only once allowed in the map; the --app address given now is allowed.
  const sites = new Sites(
    gwDir,
    (event) => {
      broadcast(event)
      if (event.type === 'site:request') console.log(`${new URL(event.origin).host} wants to send comments. Allow it in the map: ${comments.uiUrl}`)
    },
    app ? [app.origin] : [],
  )
  const overlay: OverlayCtx = { gwDir, store, nodes, sites, uiUrl: () => comments.uiUrl }

  // Colleagues' phones away from the Wi-Fi, through the team's relay, when this project has a mailbox there.
  const relayConfig = await projectRelay(gwDir)
  // Loaded only then: a project without a relay never runs any of it.
  const relay: RelaySync | undefined = relayConfig ? new (await import('../relay/sync.js')).RelaySync(relayConfig, comments, () => {
        broadcast({ type: 'relay:waiting' })
      }) : undefined

  /** Where the product runs with the Comment button, once the proxy listens. */
  const runtime: { app?: string } = {}

  let ui: Middleware = (_req, res) => res.writeHead(404).end()
  const server = createServer(async (req, res) => {
    // Only answer requests addressed to this machine. This blocks DNS rebinding,
    // where another site points its own hostname at 127.0.0.1.
    if (!isLocalHost(req.headers.host)) return res.writeHead(403).end('Forbidden')
    if (await handleComments(req, res, comments)) return
    // The Comment button for a product page that loads it itself, on the product's own address.
    if (await handleOverlay(req, res, overlay)) return
    if (await handleApi(req, res, { gwDir, store, nodes, pairings, runtime, sites, relay })) return
    if (await handleFiles(req, res, gwDir)) return
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
    ui = sirv(join(PACKAGE_ROOT, 'dist', 'ui'), {
      single: true,
      // Read from disk on each request, not listed once at start: after an
      // update or a rebuild while grndwrk runs, the fresh page names scripts
      // a list made at start would not know, and the map would load blank.
      dev: true,
      // The page must always be fresh, or a browser keeps running an old
      // build after an update. Built assets have hashed names and never change.
      setHeaders: (res, pathname) => {
        res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  const actualPort = await listen(server, port)
  comments.uiUrl = `http://localhost:${actualPort}`
  watchgrndwrk(gwDir, nodes)
  let appUrl: string | undefined
  if (app) {
    // Remembered, so the map can open screens and `grndwrk screenshots` knows where the product runs.
    await rememberApp(gwDir, app.origin).catch(() => {})
    const proxy = createProxy({ target: app, gwDir, store, nodes, uiUrl: () => comments.uiUrl })
    appUrl = `http://${proxyName(app)}:${await listen(proxy, appPort ?? actualPort + 1)}`
    runtime.app = appUrl
  }
  let lanUrls: string[] | undefined
  if (lanCode && devices) {
    const lanServer = createLanServer(comments, lanCode, devices, pairings)
    const p = await listen(lanServer, lanPort ?? actualPort + 2, 20, '0.0.0.0')
    advertise(p, project)
    lanUrls = lanAddresses().map((a) => `http://${a}:${p}`)
  }
  relay?.start()
  return { server, url: `http://localhost:${actualPort}`, appUrl, lanUrls, lanCode, relayUrl: relayConfig?.url }
}

function isLocalHost(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

/** Listen on `port`, or the next free one if it is taken. */
export async function listen(server: Server, port: number, attempts = 20, host = '127.0.0.1'): Promise<number> {
  for (let p = port; p < port + attempts; p++) {
    // macOS lets one program take 127.0.0.1:7779 while another holds *:7779.
    // Something already answering on this Mac means the port is taken, whichever address it chose.
    if (await answers(p)) continue
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
      server.listen(p, host)
    })
    if (ok) return p
  }
  throw new Error(`No free port between ${port} and ${port + attempts - 1}`)
}

/** Whether something on this Mac already answers on the port. */
/** Whether something on this Mac answers on the port. */
export function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (yes: boolean) => {
      socket.destroy()
      resolve(yes)
    }
    socket.setTimeout(300, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
