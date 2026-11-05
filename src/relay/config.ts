/**
 * What this Mac keeps about relays, in grndwrk's per-user folder, never in a
 * project (the keys would reach git): `relay.json` for the relay this person
 * deployed (its address and the owner key, which opens mailboxes), and
 * `relay-projects.json` for each project's mailbox and team key, by the
 * project's .grndwrk path. Both 0600.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stateDir } from '../root.js'

export interface OwnRelay { url: string; owner: string; name: string }
export interface ProjectRelay { url: string; mailbox: string; team: string }

const dir = () => process.env.GRNDWRK_RELAY_DIR || stateDir()
const KEY = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{32}$/

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, file)
}

export async function ownRelay(): Promise<OwnRelay | undefined> {
  const r = await readJson<Partial<OwnRelay>>(join(dir(), 'relay.json'), {})
  return typeof r.url === 'string' && typeof r.owner === 'string' && KEY.test(r.owner) ? { url: r.url, owner: r.owner, name: String(r.name ?? 'grndwrk-relay') } : undefined
}

export const saveOwnRelay = (r: OwnRelay) => writeJson(join(dir(), 'relay.json'), r)

export async function projectRelay(gwDir: string): Promise<ProjectRelay | undefined> {
  const all = await readJson<Record<string, Partial<ProjectRelay>>>(join(dir(), 'relay-projects.json'), {})
  const r = all[gwDir]
  if (!r || typeof r.url !== 'string' || !ID.test(r.mailbox ?? '') || !KEY.test(r.team ?? '')) return undefined
  return { url: r.url, mailbox: r.mailbox!, team: r.team! }
}

export async function saveProjectRelay(gwDir: string, r: ProjectRelay | null): Promise<void> {
  const file = join(dir(), 'relay-projects.json')
  const all = await readJson<Record<string, ProjectRelay>>(file, {})
  if (r) all[gwDir] = r
  else delete all[gwDir]
  await writeJson(file, all)
}

/** The relay's address: https, or http on this machine (for trying it with `wrangler dev`). */
export function relayOrigin(raw: string): string {
  const u = new URL(raw)
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('A relay is reached over https')
  return u.origin
}

/** An invite for a phone, or a team link for a teammate's grndwrk. The secret is in the #fragment, which browsers never send. */
export const inviteLink = (r: ProjectRelay, secret: string) => `${r.url}/v1/${r.mailbox}/invite#${secret}`
export const teamLink = (r: ProjectRelay) => `${r.url}/v1/${r.mailbox}/team#${r.team}`

export function parseLink(link: string, kind: 'invite' | 'team'): { url: string; mailbox: string; secret: string } {
  let u: URL
  try {
    u = new URL(link.trim())
  } catch {
    throw new Error(`Not a ${kind} link`)
  }
  const m = new RegExp(`^/v1/([a-f0-9]{32})/${kind}$`).exec(u.pathname)
  const secret = u.hash.slice(1)
  if (!m || !KEY.test(secret)) throw new Error(`Not a ${kind} link: it looks like https://<relay>/v1/<mailbox>/${kind}#<64 characters>`)
  return { url: relayOrigin(u.origin), mailbox: m[1], secret }
}
