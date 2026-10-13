import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { init } from './init.js'
import { findProjectRoot, GW_DIR, PACKAGE_ROOT } from './root.js'
import { startServer } from './server/index.js'
import { clientCount } from './server/events.js'

const HELP = `Usage:
  groundwork init        create .groundwork/ and copy the Claude Code commands, or update them
  groundwork [start]     open the map in the browser
  groundwork import-feedback <file>
                         add comments a tester shared as a file
  groundwork screenshots [screen...]
                         take a picture of each screen in the running product,
                         for the Sitemap view. Uses Chrome.
      --app <url>        where the product runs (default: the last --app)
      --login            log in once in a Chrome window; the session is kept
  groundwork build-ios-loader [path]
                         build GroundworkFeedback for injecting into an app in
                         the iOS Simulator, without changing the app; prints
                         the path for DYLD_INSERT_LIBRARIES

Options for start:
  --port <n>   port to use (default 7777, or the next free one)
  --no-open    do not open the browser
  --app <url>  your product's dev server, for example http://localhost:5173.
               Open the address Groundwork prints for it, and every page gets
               a Comment button. Comments land in the map, on the Feedback page.
  --app-port <n>  port for that address (default: the map's port plus one)
  --lan        let phones on the same Wi-Fi send comments (GroundworkFeedback
               finds this Mac by itself). They can only add comments.
  --lan-port <n>  port for that (default: the map's port plus two)
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      port: { type: 'string', default: '7777' },
      app: { type: 'string' },
      'app-port': { type: 'string' },
      lan: { type: 'boolean', default: false },
      'lan-port': { type: 'string' },
      open: { type: 'boolean', default: true },
      dev: { type: 'boolean', default: false },
      login: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const command = positionals[0] ?? 'start'

  if (values.help || command === 'help') return void console.log(HELP)

  if (command === 'init') {
    console.log(`Setting up ${GW_DIR}/ in ${process.cwd()}\n`)
    return init(process.cwd())
  }

  if (command === 'screenshots') {
    const root = findProjectRoot(process.cwd())
    if (!root) {
      console.error(`No ${GW_DIR}/ folder found here. Run \`groundwork init\` first.`)
      process.exit(1)
    }
    const { takeScreenshots } = await import('./screenshots.js')
    try {
      await takeScreenshots(join(root, GW_DIR), { app: values.app, login: values.login, only: positionals.slice(1) })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    return
  }

  if (command === 'build-ios-loader') {
    if (process.platform !== 'darwin') {
      console.error('Building for the iOS Simulator needs a Mac with Xcode.')
      process.exit(1)
    }
    const { spawnSync } = await import('node:child_process')
    const script = join(PACKAGE_ROOT, 'clients', 'ios', 'build-loader.sh')
    const run = spawnSync('/bin/sh', [script, ...positionals.slice(1, 2)], { stdio: 'inherit' })
    return void process.exit(run.status ?? 1)
  }

  if (command === 'import-feedback') {
    const root = findProjectRoot(process.cwd())
    const files = positionals.slice(1)
    if (!root || !files.length) {
      console.error(!root ? `No ${GW_DIR}/ folder found here. Run \`groundwork init\` first.` : 'Usage: groundwork import-feedback <file> [more files]')
      process.exit(1)
    }
    const { readFile } = await import('node:fs/promises')
    const { NodeStore } = await import('./store/nodes.js')
    const { importFeedback } = await import('./server/feedback.js')
    const store = new NodeStore(join(root, GW_DIR))
    for (const file of files) {
      const { added, skipped } = await importFeedback(join(root, GW_DIR), store, await readFile(file, 'utf8'))
      console.log(`${file}: ${added} added to the Feedback page${skipped ? `, ${skipped} already there or unreadable` : ''}`)
    }
    return
  }

  if (command === 'start') {
    const root = findProjectRoot(process.cwd())
    if (!root) {
      console.error(`No ${GW_DIR}/ folder found here or in any parent folder. Run \`groundwork init\` first.`)
      process.exit(1)
    }
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Not a valid port: ${values.port}`)
      process.exit(1)
    }
    let app: URL | undefined
    if (values.app) {
      try {
        app = new URL(/^https?:\/\//.test(values.app) ? values.app : `http://${values.app}`)
      } catch {
        console.error(`Not a valid address: ${values.app}`)
        process.exit(1)
      }
    }
    const appPort = values['app-port'] ? Number(values['app-port']) : undefined
    const lanPort = values['lan-port'] ? Number(values['lan-port']) : undefined
    const { url, appUrl, lanUrls, lanCode } = await startServer({ gwDir: join(root, GW_DIR), port, dev: values.dev, app, appPort, lan: values.lan, lanPort })
    console.log(`Groundwork is running at ${url}\nWatching ${join(root, GW_DIR)}`)
    if (appUrl) console.log(`Your product with the Comment button: ${appUrl} (passes through to ${app!.origin})`)
    if (lanUrls) {
      console.log(`Phones on this network can send comments: ${lanUrls.join(', ') || 'no network found'}`)
      console.log(`  Pairing code: ${lanCode}. Enter it once on each phone. Delete .groundwork/lan-code for a new one.`)
      console.log('  Only comments can be sent from there. The map stays on this Mac.')
    }
    console.log('Press Ctrl+C to stop.')
    if (values.open) {
      // A Groundwork tab that is already open reconnects by itself. Give it a
      // moment, and only open a new tab when none came back.
      await new Promise((r) => setTimeout(r, 2500))
      if (clientCount() > 0) {
        console.log('Your open Groundwork tab reconnected.')
      } else {
        const { default: open } = await import('open')
        await open(url).catch(() => {})
      }
    }
    return
  }

  console.error(`Unknown command: ${command}\n\n${HELP}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
