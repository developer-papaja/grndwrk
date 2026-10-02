import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { init } from './init.js'
import { findProjectRoot, GW_DIR } from './root.js'
import { startServer } from './server/index.js'

const HELP = `Usage:
  groundwork init        create .groundwork/ and copy the Claude Code commands
  groundwork [start]     open the map in the browser

Options for start:
  --port <n>   port to use (default 7777, or the next free one)
  --no-open    do not open the browser
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      port: { type: 'string', default: '7777' },
      open: { type: 'boolean', default: true },
      dev: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const command = positionals[0] ?? 'start'

  if (values.help || command === 'help') return void console.log(HELP)

  if (command === 'init') {
    console.log(`Setting up ${GW_DIR}/ in ${process.cwd()}\n`)
    return init(process.cwd())
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
    const { url } = await startServer({ gwDir: join(root, GW_DIR), port, dev: values.dev })
    console.log(`Groundwork is running at ${url}\nWatching ${join(root, GW_DIR)}\nPress Ctrl+C to stop.`)
    if (values.open) {
      const { default: open } = await import('open')
      await open(url).catch(() => {})
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
