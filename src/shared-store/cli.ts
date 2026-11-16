import { createInterface } from 'node:readline/promises'
import { basename, join } from 'node:path'
import { type CheckResult, checkStore } from './check.js'
import { adapterState, allowAdapter, loadAdapter, readStoreConfig, saveToken, tokenFor } from './config.js'
import { HttpStore } from './http.js'

export const STORE_HELP = `Usage:
  grndwrk store check <url | adapter.mjs> [--token <t>]
                         run the store protocol's rules against a store, yours
                         or one you are building (docs/store-protocol.md); it
                         writes a few files under nodes/n_check... and removes them
  grndwrk store login [--token <t>]
                         keep your token for the project's store (.grndwrk/store.json)
                         on this machine, never in the project
  grndwrk store allow    allow the project's store adapter as it is now, on this
                         machine; asked again whenever the file changes
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

  if (!root || !gwDir) return void console.error('Run this inside a project with a .grndwrk folder.')
  const config = await readStoreConfig(gwDir)

  if (sub === 'login') {
    if (!config || !('url' in config)) return void console.error('.grndwrk/store.json names no store address ("url").')
    const t = token ?? (await ask(`Token for ${config.url}: `))
    if (!t) return void console.error('No token given.')
    const store = new HttpStore(config.url, t)
    const hello = await store.hello()
    await saveToken(config.url, t)
    return void console.log(`Kept on this machine. ${hello.project || 'The store'} answers${hello.writable ? '' : ', for reading only'}.`)
  }

  if (sub === 'allow') {
    if (!config || !('adapter' in config)) return void console.error('.grndwrk/store.json names no adapter.')
    const state = await adapterState(root, config.adapter)
    if (state === 'allowed') return void console.log(`${config.adapter} is allowed as it is.`)
    console.log(`${config.adapter} runs on this machine with your rights each time grndwrk syncs. ${state === 'changed' ? 'It changed since you allowed it: read the change (git diff) first.' : 'Read it first.'}`)
    // Only a person at a terminal allows code to run: never an agent or a script.
    if (!process.stdin.isTTY) return void console.error('Run grndwrk store allow yourself, in a terminal.')
    if ((await ask('Allow it? [y/N] ')).toLowerCase() !== 'y') return void console.log('Not allowed.')
    await allowAdapter(root, config.adapter)
    return void console.log(`Allowed on this machine, as it is now. If it changes, grndwrk asks again.`)
  }

  console.log(STORE_HELP)
}
