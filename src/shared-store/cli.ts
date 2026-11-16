import { createInterface } from 'node:readline/promises'
import { basename, join } from 'node:path'
import { type CheckResult, checkStore } from './check.js'
import { adapterState, allowAdapter, loadAdapter, openStore, readStoreConfig, saveToken, type StoreConfig, tokenFor, writeStoreConfig } from './config.js'
import { HttpStore } from './http.js'
import { writePageAssets } from './page.js'

export const STORE_HELP = `Usage:
  grndwrk store use <url | adapter.mjs> [--token <t>]
                         keep this project's map in your team's store from now
                         on (writes .grndwrk/store.json); grndwrk start syncs
                         .grndwrk/ with it while it runs
  grndwrk store sync     sync .grndwrk/ with the store once, and stop
  grndwrk store leave    stop using the store; .grndwrk/ stays as it is
  grndwrk store check <url | adapter.mjs> [--token <t>]
                         run the store protocol's rules against a store, yours
                         or one you are building (docs/store-protocol.md); it
                         writes a few files under nodes/n_check... and removes them
  grndwrk store login [--token <t>]
                         keep your token for the project's store (.grndwrk/store.json)
                         on this machine, never in the project
  grndwrk store allow    allow the project's store adapter as it is now, on this
                         machine; asked again whenever the file changes
  grndwrk store assets <dir>
                         write what a store hosts into <dir>: the page that lets
                         colleagues read the map and answer in a browser, and the
                         Comment button for a staging site; copy it to your store
`

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export async function storeCommand(args: string[], root: string | null, token?: string): Promise<void> {
  const [sub, target] = args
  const gwDir = root ? join(root, '.grndwrk') : null

  if (sub === 'check') {
    if (!target) return void console.error('Usage: grndwrk store check <url | adapter.mjs> [--token <t>]')
    let results: CheckResult[]
    if (/\.mjs$/.test(target)) {
      if (!root) return void console.error('An adapter is checked from inside its project.')
      if ((await adapterState(root, target)) !== 'allowed') {
        console.log(`Checking runs ${target}. Read it first; allowing it here is the same as grndwrk store allow.`)
        if ((await ask('Allow and run it? [y/N] ')).toLowerCase() !== 'y') return void console.log('Not run.')
        await allowAdapter(root, target)
      }
      results = await checkStore(await loadAdapter(root, target, basename(root)))
    } else {
      const t = token ?? (await tokenFor(target).catch(() => null)) ?? (await ask('Token for this store (it may write): '))
      if (!t) return void console.error('A token is needed: --token <t>')
      results = await checkStore(new HttpStore(target, t), { url: target, token: t })
    }
    for (const r of results) console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.rule}${r.detail ? `\n         ${r.detail}` : ''}`)
    const failed = results.filter((r) => !r.ok).length
    console.log(failed ? `\n${failed} of ${results.length} rules failed. docs/store-protocol.md says what each one means.` : `\nAll ${results.length} rules kept. This store speaks the protocol.`)
    return void (process.exitCode = failed ? 1 : 0)
  }

  if (sub === 'assets') {
    if (!target) return void console.error('Usage: grndwrk store assets <dir>')
    try {
      const names = await writePageAssets(target)
      console.log(`Wrote ${names.length} files to ${target}: the page (index.html, assets/), ${names.filter((n) => !n.startsWith('assets/') && n !== 'index.html').join(', ')}.`)
      console.log('Your store serves this folder at each project\'s address, <store>/<project>/ (see its README and docs/store-protocol.md, The page).')
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }

  if (!root || !gwDir) return void console.error('Run this inside a project with a .grndwrk folder.')
  const config = await readStoreConfig(gwDir)

  if (sub === 'use') {
    if (!target) return void console.error('Usage: grndwrk store use <url | adapter.mjs> [--token <t>]')
    return void (await useStore(root, target, token))
  }

  if (sub === 'login') {
    if (!config || !('url' in config)) return void console.error('.grndwrk/store.json names no store address ("url").')
    return void (await login(config.url, token))
  }

  if (sub === 'allow') {
    if (!config || !('adapter' in config)) return void console.error('.grndwrk/store.json names no adapter.')
    return void (await allow(root, config.adapter))
  }

  if (sub === 'sync') {
    if (!config) return void console.error('This project keeps its map in .grndwrk only: there is no store.json. Run grndwrk store use <url | adapter.mjs> first.')
    return void (await syncOnce(root, gwDir))
  }

  if (sub === 'leave') {
    if (!config) return void console.log('This project uses no store. Nothing to leave.')
    await writeStoreConfig(gwDir, null)
    const { rm } = await import('../store/fs.js')
    await rm(join(gwDir, 'store-sync.json'), { force: true })
    return void console.log(`This project no longer uses the store at ${'url' in config ? config.url : config.adapter}. The map stays in .grndwrk as it is.`)
  }

  console.log(STORE_HELP)
}

/** Keep the token for a store on this machine, after it answered with it. True when kept. */
async function login(url: string, token?: string): Promise<boolean> {
  const t = token ?? (await ask(`Token for ${url}: `))
  if (!t) {
    console.error('No token given. Run grndwrk store login when you have one.')
    return false
  }
  const store = new HttpStore(url, t)
  const hello = await store.hello()
  await saveToken(url, t)
  console.log(`Kept on this machine. ${hello.project || 'The store'} answers${hello.writable ? '' : ', for reading only'}.`)
  return true
}

/** Allow the adapter as it is now, asked of a person at a terminal. True when allowed. */
async function allow(root: string, adapter: string): Promise<boolean> {
  const state = await adapterState(root, adapter)
  if (state === 'allowed') {
    console.log(`${adapter} is allowed as it is.`)
    return true
  }
  console.log(`${adapter} runs on this machine with your rights each time grndwrk syncs. ${state === 'changed' ? 'It changed since you allowed it: read the change (git diff) first.' : 'Read it first.'}`)
  // Only a person at a terminal allows code to run: never an agent or a script.
  if (!process.stdin.isTTY) {
    console.error('Run grndwrk store allow yourself, in a terminal.')
    return false
  }
  if ((await ask('Allow it? [y/N] ')).toLowerCase() !== 'y') {
    console.log('Not allowed.')
    return false
  }
  await allowAdapter(root, adapter)
  console.log('Allowed on this machine, as it is now. If it changes, grndwrk asks again.')
  return true
}

/**
 * `grndwrk store use`: the project's map is kept in this store from now on.
 * store.json is written once the address or file is valid; the token (or
 * allowing the adapter) follows, and can be done later.
 */
export async function useStore(root: string, target: string, token?: string): Promise<StoreConfig | null> {
  const gwDir = join(root, '.grndwrk')
  const config: StoreConfig = /\.mjs$/.test(target) ? { adapter: target } : { url: target }
  await writeStoreConfig(gwDir, config)
  try {
    // Read back as start will read it: an address over http, or an adapter outside the project, is refused here.
    await readStoreConfig(gwDir)
    if ('adapter' in config) await adapterState(root, config.adapter)
  } catch (err) {
    await writeStoreConfig(gwDir, null)
    console.error(err instanceof Error ? err.message : String(err))
    return null
  }
  console.log(`This project's map is kept in ${target} from now on (.grndwrk/store.json).`)
  const ready = 'url' in config ? ((await tokenFor(config.url)) ? true : await login(config.url, token).catch((err) => (console.error(err instanceof Error ? err.message : String(err)), false))) : await allow(root, config.adapter)
  console.log(ready ? 'grndwrk start syncs .grndwrk with it while it runs; grndwrk store sync does it once now.' : 'Once that is done, grndwrk start syncs .grndwrk with it.')
  return config
}

/** One full pass, said in a line; for `grndwrk store sync` and init. */
export async function syncOnce(root: string, gwDir: string) {
  const project = basename(root)
  let client: Awaited<ReturnType<typeof openStore>>
  try {
    client = await openStore(root, gwDir, project)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return void (process.exitCode = 1)
  }
  if (!client) return
  const { StoreSync, describe } = await import('./sync.js')
  const { NodeStore } = await import('../store/nodes.js')
  const { NodeSync } = await import('../server/events.js')
  const store = new NodeStore(gwDir)
  const ctx = { gwDir, store, nodes: new NodeSync(() => store.list()), project, uiUrl: '' }
  const sync = new StoreSync(gwDir, client, ctx)
  try {
    const c = await sync.fullPass()
    console.log(`Synced: ${describe(c) || 'nothing new'}.${c.conflicts ? ` Your side of each conflict is kept in ${sync.conflictsDir()}` : ''}`)
  } catch (err) {
    console.error(`Could not sync: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
