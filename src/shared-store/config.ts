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
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile as readPlain, realpath, rename, writeFile as writePlain } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from '../store/fs.js'
import { stateDir } from '../root.js'
import { HttpStore } from './http.js'
import { type StoreClient, StoreBroke } from './protocol.js'

export type StoreConfig = { url: string } | { adapter: string }

const dir = () => process.env.GRNDWRK_STORE_DIR || stateDir()

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
  if (process.env.GRNDWRK_STORE_TOKEN) return process.env.GRNDWRK_STORE_TOKEN
  const all = await readJson<Record<string, string>>(join(dir(), 'store-tokens.json'), {})
  return all[new URL(url).toString()] ?? null
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

/** Allow the adapter as it is now on this machine. Returns its hash. */
export async function allowAdapter(projectRoot: string, adapter: string): Promise<string> {
  const full = await adapterPath(projectRoot, adapter)
  const hash = hashOf(await readPlain(full))
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
  // The hash in the address: a changed file is a new module, never a cached old one.
  const mod = (await import(`${pathToFileURL(full).href}?sha=${hash}`)) as { default?: unknown }
  if (typeof mod.default !== 'function') throw new StoreBroke(`${adapter}: the default export is a function that returns the store`)
  const store = (await (mod.default as (o: { project: string; root: string }) => Promise<StoreClient>)({ project, root: projectRoot })) as StoreClient
  for (const call of ['hello', 'changes', 'read', 'write', 'remove'] as const) {
    if (typeof store?.[call] !== 'function') throw new StoreBroke(`${adapter}: the store has no ${call}()`)
  }
  return store
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
