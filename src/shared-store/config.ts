/**
 * Where a project's map is kept, and what lets this person reach it.
 *
 * - `.grndwrk/store.json` (in the project, shared through git when the team
 *   wants): `{ "url": "https://..." }` for a store over HTTP, or
 *   `{ "adapter": "tools/grndwrk-store.mjs" }` for an adapter in the repo.
 *   No store.json: the map is the folder, as always.
 * - Tokens, per person, in grndwrk's per-user folder (`store-tokens.json`,
 *   0600, by store address), or `GRNDWRK_STORE_TOKEN`. Never in the project.
 * - Adapters allowed on this machine (`store-allowed.json`, 0600): the
 *   adapter's full path and the hash of the exact file that was allowed.
 *   A changed file is not loaded until it is allowed again.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile as readPlain, realpath, rename, rm as rmPlain, writeFile as writePlain } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir as mkdirGuarded, readFile, writeFile as writeGuarded } from '../store/fs.js'
import { stateDir } from '../root.js'
import { HttpStore } from './http.js'
import { checkChanges, CursorGone, type StoreClient, StoreBroke } from './protocol.js'

export type StoreConfig = { url: string } | { adapter: string }

/** grndwrk's per-user folder for the store: tokens, allowed adapters, conflicts kept. */
export const storeStateDir = () => process.env.GRNDWRK_STORE_DIR || stateDir()
const dir = storeStateDir

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readPlain(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writePlain(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
}

/** The project's store.json, checked, or null when the map is only the folder. */
export async function readStoreConfig(gwDir: string): Promise<StoreConfig | null> {
  let raw: string
  try {
    raw = await readFile(join(gwDir, 'store.json'), 'utf8')
  } catch {
    return null
  }
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new StoreBroke('.grndwrk/store.json is not valid JSON')
  }
  if (typeof v.url === 'string' && !v.adapter) {
    const u = new URL(v.url)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new StoreBroke('store.json: a store is reached over https')
    return { url: u.toString() }
  }
  if (typeof v.adapter === 'string' && !v.url) return { adapter: v.adapter }
  throw new StoreBroke('store.json holds either "url" or "adapter"')
}

export async function writeStoreConfig(gwDir: string, config: StoreConfig | null): Promise<void> {
  const { writeFile, rm } = await import('../store/fs.js')
  const file = join(gwDir, 'store.json')
  if (!config) return void (await rm(file, { force: true }))
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

// Tokens

export async function tokenFor(url: string): Promise<string | null> {
  // From the environment (CI, a script) only for the store it names: a pull request
  // that points store.json elsewhere must not receive it.
  if (process.env.GRNDWRK_STORE_TOKEN) {
    const named = process.env.GRNDWRK_STORE_URL
    if (named && sameStore(named, url)) return process.env.GRNDWRK_STORE_TOKEN
    if (!named) console.error('GRNDWRK_STORE_TOKEN is set without GRNDWRK_STORE_URL, so it is not used: name the store it is for.')
  }
  const all = await readJson<Record<string, string>>(join(dir(), 'store-tokens.json'), {})
  return all[new URL(url).toString()] ?? null
}

const sameStore = (a: string, b: string) => {
  try {
    return new URL(a).toString().replace(/\/?$/, '/') === new URL(b).toString().replace(/\/?$/, '/')
  } catch {
    return false
  }
}

/** Whether this machine kept a token for any store on that host before: a new one is worth a second look. */
export async function knownHost(url: string): Promise<boolean> {
  const all = await readJson<Record<string, string>>(join(dir(), 'store-tokens.json'), {})
  const host = new URL(url).host
  return Object.keys(all).some((k) => {
    try {
      return new URL(k).host === host
    } catch {
      return false
    }
  })
}

export async function saveToken(url: string, token: string | null): Promise<void> {
  const file = join(dir(), 'store-tokens.json')
  const all = await readJson<Record<string, string>>(file, {})
  const key = new URL(url).toString()
  if (token) all[key] = token
  else delete all[key]
  await writeJson(file, all)
}

// Adapters

/**
 * The adapter's full path, if it is a `.mjs` file inside the project that is
 * no link and in no linked folder. Anything else is refused before it is read.
 */
export async function adapterPath(projectRoot: string, adapter: string): Promise<string> {
  if (isAbsolute(adapter) || !/\.mjs$/.test(adapter)) throw new StoreBroke('store.json: the adapter is a .mjs file, given by its path inside the project')
  const root = await realpath(projectRoot)
  const full = resolve(root, adapter)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new StoreBroke('store.json: the adapter must be inside the project')
  if ((await lstat(full)).isSymbolicLink() || (await realpath(full)) !== full) throw new StoreBroke('store.json: the adapter may not be a link, nor sit in a linked folder')
  for (const part of rel.split(sep)) if (part === 'node_modules') throw new StoreBroke('store.json: the adapter is your own file, not one in node_modules')
  return full
}

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/**
 * Why the adapter's source cannot be allowed, or ''. Allowing covers this one
 * file, so it may import installed packages (`firebase-admin`, `node:crypto`)
 * but must not be able to run code from anywhere else: no file of the
 * repository, no address it works out while running, and none of the ways
 * Node has to run other code (require, eval, Function, vm, child processes,
 * workers, module hooks). Read on the raw text, comments and strings
 * included, so nothing can be hidden behind something that only looks like a
 * comment; a false alarm costs a rewrite, a miss would run unseen code.
 */
export function adapterImportProblem(source: string): string {
  const one = 'an adapter is one file, and may import installed packages only'
  const named = (name: string) => {
    if (/^(node:)?(child_process|vm|module|worker_threads|cluster|inspector|wasi)(\/|$)/.test(name)) return `it imports ${name}, which can run other code`
    if (/^node:[a-z_/]+$/.test(name)) return ''
    // A package's name, then plain folder names: no '.', '..', '%' or '\', which could climb out of node_modules into the repository.
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/i.test(name) || name.split('/').some((s) => s === '.' || s === '..')) return `it imports ${name}: ${one}`
    return ''
  }
  // Every specifier written after import or from, whatever surrounds it.
  for (const m of source.matchAll(/\b(?:from|import)\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    if (m[1] === '`' && m[2].includes('${')) return `it imports an address it works out while running (${m[2].slice(0, 40)})`
    const problem = named(m[2])
    if (problem) return problem
  }
  // import(...): one plain string naming an installed package, nothing else.
  for (const m of source.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const plain = /^(['"])([^'"`\\$]*)\1\s*$/.exec(m[1])
    if (!plain) return `it imports an address it works out while running (${m[1].slice(0, 40)})`
    const problem = named(plain[2])
    if (problem) return problem
  }
  const words: [RegExp, string][] = [
    [/\brequire\s*\(|\bcreateRequire\b|\bmainModule\b/, 'require'],
    [/\beval\s*\(|\bFunction\s*\(|\bnew\s+Function\b/, 'eval or Function'],
    [/import\.meta\.resolve|\bregisterHooks\b|\bmodule\.register\b|process\.binding|process\.dlopen/, 'module hooks or native code'],
  ]
  for (const [re, what] of words) if (re.test(source)) return `it uses ${what}, which can run code from another file: ${one}`
  return ''
}

/** Allow the adapter as it is now on this machine. Returns its hash. */
export async function allowAdapter(projectRoot: string, adapter: string): Promise<string> {
  const full = await adapterPath(projectRoot, adapter)
  const bytes = await readPlain(full)
  const problem = adapterImportProblem(bytes.toString('utf8')) || (await packagesInMap(projectRoot))
  if (problem) throw new StoreBroke(`${adapter} cannot be allowed: ${problem}`)
  const hash = hashOf(bytes)
  const file = join(dir(), 'store-allowed.json')
  const all = await readJson<Record<string, string>>(file, {})
  all[full] = hash
  await writeJson(file, all)
  return hash
}

/** Whether the adapter is exactly the file that was allowed: 'allowed', 'changed' or 'never'. */
export async function adapterState(projectRoot: string, adapter: string): Promise<'allowed' | 'changed' | 'never'> {
  const full = await adapterPath(projectRoot, adapter)
  const allowed = (await readJson<Record<string, string>>(join(dir(), 'store-allowed.json'), {}))[full]
  if (!allowed) return 'never'
  return hashOf(await readPlain(full)) === allowed ? 'allowed' : 'changed'
}

export class AdapterNotAllowed extends Error {}

/**
 * The adapter runs from a copy in .grndwrk/, so Node would look for its
 * packages in .grndwrk/node_modules before the project's: a commit to the
 * map alone could then change what an allowed adapter runs. Refused while
 * one is there.
 */
async function packagesInMap(projectRoot: string): Promise<string> {
  const there = await lstat(join(projectRoot, '.grndwrk', 'node_modules')).then(() => true, () => false)
  return there ? '.grndwrk/node_modules would change which packages the adapter imports: remove it' : ''
}

/**
 * Load an allowed adapter. Refused when it was never allowed on this machine
 * or the file changed since: grndwrk never runs code from the repository the
 * person has not seen and allowed.
 */
export async function loadAdapter(projectRoot: string, adapter: string, project: string): Promise<StoreClient> {
  const full = await adapterPath(projectRoot, adapter)
  const bytes = await readPlain(full)
  const allowed = (await readJson<Record<string, string>>(join(dir(), 'store-allowed.json'), {}))[full]
  if (!allowed) throw new AdapterNotAllowed(`The store adapter ${adapter} is not allowed on this machine yet. Read it, then run: grndwrk store allow`)
  const hash = hashOf(bytes)
  if (hash !== allowed) throw new AdapterNotAllowed(`The store adapter ${adapter} changed since it was allowed. Read what changed (git diff), then run: grndwrk store allow`)
  const problem = adapterImportProblem(bytes.toString('utf8')) || (await packagesInMap(projectRoot))
  if (problem) throw new AdapterNotAllowed(`${adapter} is not loaded: ${problem}`)
  // Run exactly the bytes that were hashed, never the file read again a moment later. The copy sits
  // in .grndwrk/, so installed packages resolve from the project as from the adapter; it goes at once.
  const copyDir = join(projectRoot, '.grndwrk', `.adapter-${randomBytes(6).toString('hex')}`)
  // Through grndwrk's own file calls: a .grndwrk that is a link is refused, as everywhere.
  await mkdirGuarded(copyDir, { recursive: true, mode: 0o700 })
  const copy = join(copyDir, `adapter-${hash.slice(0, 16)}.mjs`)
  let mod: { default?: unknown }
  try {
    // A package of its own without a name: an import can never mean .grndwrk/package.json or the
    // project's own package.json (Node's self-reference), only a package installed in node_modules.
    await writeGuarded(join(copyDir, 'package.json'), Buffer.from('{"type":"module"}\n'), { mode: 0o600, flag: 'wx' })
    await writeGuarded(copy, bytes, { mode: 0o600, flag: 'wx' })
    mod = (await import(pathToFileURL(copy).href)) as { default?: unknown }
  } finally {
    await rmPlain(copyDir, { recursive: true, force: true })
  }
  if (typeof mod.default !== 'function') throw new StoreBroke(`${adapter}: the default export is a function that returns the store`)
  const store = (await (mod.default as (o: { project: string; root: string }) => Promise<StoreClient>)({ project, root: projectRoot })) as StoreClient
  for (const call of ['hello', 'changes', 'read', 'write', 'remove'] as const) {
    if (typeof store?.[call] !== 'function') throw new StoreBroke(`${adapter}: the store has no ${call}()`)
  }
  // An adapter cannot reach grndwrk's own CursorGone: an error named so (or with code CURSOR_GONE) means the same.
  const changes = store.changes.bind(store)
  return Object.assign(Object.create(store) as StoreClient, {
    hello: store.hello.bind(store),
    read: store.read.bind(store),
    write: store.write.bind(store),
    remove: store.remove.bind(store),
    changes: async (o: { since?: string; wait?: number }) => {
      try {
        return checkChanges(await changes(o))
      } catch (err) {
        const e = err as { name?: unknown; code?: unknown }
        if (e?.name === 'CursorGone' || e?.code === 'CURSOR_GONE') throw new CursorGone(o.since ?? '')
        throw err
      }
    },
  })
}

/** The project's store, ready to call, or null when the map is only the folder. */
export async function openStore(projectRoot: string, gwDir: string, project: string): Promise<StoreClient | null> {
  const config = await readStoreConfig(gwDir)
  if (!config) return null
  if ('adapter' in config) return loadAdapter(projectRoot, config.adapter, project)
  const token = await tokenFor(config.url)
  if (!token) throw new StoreBroke(`No token for ${config.url} on this machine. Run: grndwrk store login`)
  return new HttpStore(config.url, token)
}
