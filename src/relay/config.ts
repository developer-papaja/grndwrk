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

/** A staging site's origin, as the relay checks it (relay/src/relay.ts siteOrigin): https (http only for localhost), no login in it; '' otherwise. */
export function siteOrigin(text: string): string {
  try {
    const u = new URL(text.trim())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return ''
    if (u.username || u.password) return ''
    return u.origin
  } catch {
    return ''
  }
}

/**
 * An invite for a phone, or a team link for a teammate's grndwrk:
 * `grndwrk:invite/<relay host>/<mailbox>/<secret>`. Not a web address on
 * purpose: opened in a browser it would go to the relay, and a relay that
 * was tampered with could read the secret from the page. The relay is
 * reached over https (http only for localhost, to try it out).
 */
export const inviteLink = (r: ProjectRelay, secret: string) => `grndwrk:invite/${new URL(r.url).host}/${r.mailbox}/${secret}`
export const teamLink = (r: ProjectRelay) => `grndwrk:team/${new URL(r.url).host}/${r.mailbox}/${r.team}`

export function parseLink(link: string, kind: 'invite' | 'team'): { url: string; mailbox: string; secret: string } {
  const m = new RegExp(`^grndwrk:${kind}/([a-z0-9.-]+(?::\\d{1,5})?)/([a-f0-9]{32})/([a-f0-9]{64})$`).exec(link.trim())
  if (!m) throw new Error(`Not a ${kind} link: it looks like grndwrk:${kind}/<relay>/<32 characters>/<64 characters>`)
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(m[1])
  return { url: relayOrigin(`${local ? 'http' : 'https'}://${m[1]}`), mailbox: m[2], secret: m[3] }
}

/** Envelopes handled per phone, by the id the phone gave each, with its time: one handed over again is refused. In the per-user folder. */
export async function readSeen(mailbox: string): Promise<Record<string, Record<string, number>>> {
  return readJson(join(dir(), 'relay-seen', `${mailbox}.json`), {})
}
export const saveSeen = (mailbox: string, seen: Record<string, Record<string, number>>) => writeJson(join(dir(), 'relay-seen', `${mailbox}.json`), seen)
