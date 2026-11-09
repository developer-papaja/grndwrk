import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { init } from './init.js'
import { findProjectRoot, GW_DIR, noMapMessage, PACKAGE_ROOT } from './root.js'
import { startServer } from './server/index.js'
import { clientCount, tabAround } from './server/events.js'
import { openTarget } from './opener.js'

const HELP = `Usage:
  grndwrk init        create .grndwrk/ and install the agent commands and skills, or update them
  grndwrk [start]     open the map in the browser
  grndwrk check       read every file in .grndwrk/ as the map does and say
                         what does not read, what to quote, and questions the
                         map will not show; run it after writing map files
  grndwrk import-feedback <file>
                         add comments a tester shared as a file
  grndwrk screenshots [screen...]
                         take a picture of each screen in the running product,
                         for the Sitemap view. Uses Chrome.
      --app <url>        where the product runs (default: the last --app)
      --login            log in once in a Chrome window; the session is kept
  grndwrk relay [deploy | add | join <team link> | leave]
                         comments from colleagues' phones away from your Wi-Fi,
                         through a relay on your own Cloudflare account
  grndwrk build-ios-loader [path]
                         build GrndwrkFeedback for injecting into an app in
                         the iOS Simulator, without changing the app; prints
                         the path for DYLD_INSERT_LIBRARIES

Options for start:
  --port <n>   this project's port from now on (default: the one it had last time;
               a new project gets the first one from 7777 no other project keeps)
  --no-open    do not open the browser
  --app <url>  your product's dev server, for example http://localhost:5173.
               Open the address grndwrk prints for it, and every page gets
               a Comment button. Comments land in the map, on the Feedback page.
  --app-port <n>  port for that address (default: the map's port plus one)
  --lan        let phones on the same Wi-Fi send comments (GrndwrkFeedback
               finds this Mac by itself). They can only add comments.
  --lan-port <n>  port for that (default: the map's port plus two)
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      port: { type: 'string' },
      app: { type: 'string' },
      'app-port': { type: 'string' },
      lan: { type: 'boolean', default: false },
      'lan-port': { type: 'string' },
      open: { type: 'boolean', default: true },
      dev: { type: 'boolean', default: false },
      login: { type: 'boolean', default: false },
      name: { type: 'string' },
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
      console.error(noMapMessage(process.cwd()))
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

  if (command === 'check') {
    const root = findProjectRoot(process.cwd())
    if (!root) {
      console.error(noMapMessage(process.cwd()))
      process.exit(1)
    }
    const { checkMap, formatFindings } = await import('./check.js')
    const findings = await checkMap(join(root, GW_DIR))
    console.log(formatFindings(findings))
    return void process.exit(findings.length ? 1 : 0)
  }

  if (command === 'import-feedback') {
    const root = findProjectRoot(process.cwd())
    const files = positionals.slice(1)
    if (!root || !files.length) {
      console.error(!root ? noMapMessage(process.cwd()) : 'Usage: grndwrk import-feedback <file> [more files]')
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

  if (command === 'relay') {
    const { relayCommand, RELAY_HELP } = await import('./relay/cli.js')
    if (positionals[1] === 'help') return void console.log(RELAY_HELP)
    const root = findProjectRoot(process.cwd())
    return relayCommand(positionals.slice(1), root ? join(root, GW_DIR) : undefined, values.name)
  }

  if (command === 'start') {
    const root = findProjectRoot(process.cwd())
    if (!root) {
      console.error(noMapMessage(process.cwd()))
      process.exit(1)
    }
    // The port this project had last time, so a line in the product's layout
    // that loads the Comment button keeps pointing at the right grndwrk.
    // A new project gets ports no other project on this Mac keeps, running or not.
    const gwDir = join(root, GW_DIR)
    const { rememberedPort, rememberPort } = await import('./store/local.js')
    const { readPorts, keepPort, clashesWith, freePort } = await import('./store/ports.js')
    const { answers } = await import('./server/index.js')
    const kept = await readPorts()
    const before = await rememberedPort(gwDir)
    const port = values.port ? Number(values.port) : (before ?? (await freePort(kept, gwDir, answers)))
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
    const { url, appUrl, lanUrls, lanCode, relayUrl } = await startServer({ gwDir: join(root, GW_DIR), port, dev: values.dev, app, appPort, lan: values.lan, lanPort })
    const actual = Number(new URL(url).port)
    console.log(`grndwrk is running at ${url}\nWatching ${gwDir}`)
    // --port moves the project for good; a new project keeps the port it got.
    const own = values.port ? port : (before ?? actual)
    if (own !== before) await rememberPort(gwDir, own)
    await keepPort(gwDir, own)
    if (values.port && before !== undefined && before !== port) {
      console.log(`  This project uses port ${port} from now on (it was ${before}). A Comment button loaded from localhost:${before} needs the new port.`)
    }
    if (actual !== own) {
      console.log(`  Port ${own}, this project's usual one, is taken (another grndwrk?), so this one runs on ${actual}. A Comment button loaded from localhost:${own} will not reach it until that one stops.`)
    }
    const clash = clashesWith(kept, gwDir, own)
    if (clash.length) {
      const free = await freePort({ ...kept, [gwDir]: own }, gwDir, answers)
      console.log(`  Ports ${own} to ${own + 2} are also kept by ${clash.join(', ')}. Move this project with grndwrk --port ${free} (once; it is kept).`)
    }
    if (appUrl) {
      console.log(`Your product with the Comment button: ${appUrl} (passes through to ${app!.origin})`)
      console.log(`  Or on ${app!.origin} itself: add this to its page layout, for local development only, and reload:`)
      console.log(`    <script src="${url}/__grndwrk/feedback.js" defer></script>`)
      console.log(`  In Laravel: @env('local') <script src="${url}/__grndwrk/feedback.js" defer></script> @endenv`)
    }
    if (lanUrls) {
      console.log(`Phones on this network can send comments: ${lanUrls.join(', ') || 'no network found'}`)
      console.log(`  Pairing code: ${lanCode}. Enter it once on a phone, or allow the phone in the map. Delete .grndwrk/lan-code for a new code, .grndwrk/lan-devices.json to unpair every phone.`)
      console.log('  Only comments can be sent from there. The map stays on this Mac.')
    }
    if (relayUrl) console.log(`Colleagues' phones send comments through the relay at ${relayUrl}. Invite them in the map: the globe at the bottom of the rail.`)
    console.log('Press Ctrl+C to stop.')
    // Whether a map tab is open, kept for the next start: a tab in the
    // background reconnects only when it is looked at again, so it would not
    // be seen in time, and a new tab would open every time.
    const { rememberedTab, rememberTab } = await import('./store/local.js')
    const hadTab = (await rememberedTab(join(root, GW_DIR))) === actual
    const stop = () => {
      setTimeout(() => process.exit(0), 1000).unref()
      void rememberTab(join(root, GW_DIR), tabAround() ? actual : null).finally(() => process.exit(0))
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    if (values.open) {
      // A grndwrk tab in view reconnects within a second. Give it a moment,
      // and only open a new tab when none came back and none was open before.
      await new Promise((r) => setTimeout(r, 2500))
      if (clientCount() > 0) {
        console.log('Your open grndwrk tab reconnected.')
      } else if (hadTab) {
        console.log(`Your grndwrk tab picks this up when you switch to it. Closed it? Open ${url}`)
      } else {
        await openTarget(url).catch(() => {})
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
