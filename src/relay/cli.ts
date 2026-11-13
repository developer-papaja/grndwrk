/**
 * `grndwrk relay ...`: set up the team's relay on Cloudflare, give a project
 * a mailbox there, and connect a teammate's grndwrk to it.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT, stateDir } from '../root.js'
import { RelayClient } from './client.js'
import { ownRelay, parseLink, projectRelay, relayOrigin, saveOwnRelay, saveProjectRelay, siteOrigin, teamLink } from './config.js'
import { ownerAuthKey, randomId, randomKey, teamAuthKey } from './keys.js'

/**
 * Cloudflare's own tool, never installed with grndwrk: `deploy` installs it
 * in grndwrk's per-user folder from relay/package-lock.json, so it and
 * every package under it are the versions that were reviewed, then runs it.
 */
export const WRANGLER = 'wrangler 4.151.3'

export const RELAY_HELP = `Usage:
  grndwrk relay deploy [--name <name>]
                       put the relay on your Cloudflare account (free plan), once.
                       Opens Cloudflare's login the first time. Run again to update it.
  grndwrk relay add    give this project a mailbox at your relay, and print
                       the team link for teammates
  grndwrk relay join <team link>
                       connect this project's grndwrk to the team's relay
  grndwrk relay        where this project's comments come through
  grndwrk relay link   the team link for teammates (it opens the project's comments: send it privately)
  grndwrk relay site <https://staging.example.com>
                       let colleagues comment from the staging site, through the relay;
                       prints the line to add to the staging site's layout. off: stop it
  grndwrk relay leave  stop using the relay in this project, on this Mac
`

export async function relayCommand(args: string[], gwDir: string | undefined, name?: string): Promise<void> {
  const [sub = 'status', arg] = args
  if (sub === 'deploy') return deploy(name)
  if (!gwDir) throw new Error('Run this in a project with a .grndwrk/ folder (grndwrk init first).')
  if (sub === 'add') return add(gwDir)
  if (sub === 'join') return join_(gwDir, arg)
  if (sub === 'leave') {
    await saveProjectRelay(gwDir, null)
    return void console.log('This project no longer uses the relay on this Mac. Its mailbox stays for your teammates; grndwrk relay join brings it back.')
  }
  if (sub === 'status') return status(gwDir)
  if (sub === 'site') return site(gwDir, arg)
  if (sub === 'link') {
    const r = await projectRelay(gwDir)
    if (!r) throw new Error('This project does not use a relay.')
    return printTeamLink(r)
  }
  throw new Error(`Unknown: grndwrk relay ${sub}\n\n${RELAY_HELP}`)
}

async function deploy(name?: string) {
  const had = await ownRelay()
  const worker = (name ?? had?.name ?? 'grndwrk-relay').toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) throw new Error('A relay name is lowercase letters, digits and dashes')
  // The relay's code, as shipped with this grndwrk, in grndwrk's own folder: never in a project.
  const dir = join(stateDir(), 'relay-worker')
  await mkdir(dir, { recursive: true })
  await cp(join(PACKAGE_ROOT, 'relay', 'src'), join(dir, 'src'), { recursive: true, force: true })
  // The Comment button for a staging site, from this grndwrk, served by the relay to that site only.
  await writeFile(join(dir, 'src', 'assets.ts'), await relayAssets())
  for (const f of ['package.json', 'package-lock.json']) await cp(join(PACKAGE_ROOT, 'relay', f), join(dir, f), { force: true })
  const toml = await readFile(join(PACKAGE_ROOT, 'relay', 'wrangler.toml'), 'utf8')
  await writeFile(join(dir, 'wrangler.toml'), toml.replace(/^name = ".*"$/m, `name = "${worker}"`))

  console.log(`Setting up your relay on Cloudflare, as "${worker}". It takes three steps.\n`)

  console.log('1. Getting wrangler ready: Cloudflare\'s own command-line tool for putting code on their servers. grndwrk uses it only for this, at the exact version it was tested with (ignore it if it says an update is available). The first time this takes a minute...')
  await run(['ci', '--no-audit', '--no-fund', '--loglevel=error'], dir, { tool: 'npm', quiet: true })

  console.log('\n2. Logging in to Cloudflare.')
  if (await loggedIn(dir)) console.log('   You are logged in already.')
  else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Cloudflare needs you to log in, and this terminal cannot open a login. Run grndwrk relay deploy in a normal terminal window, or set CLOUDFLARE_API_TOKEN to an API token from your Cloudflare dashboard (My Profile, API Tokens, the "Edit Cloudflare Workers" template).')
    }
    console.log('   A browser window opens. Log in, or make a free account, then click Allow and come back here.\n')
    await run(['--no-install', 'wrangler', 'login'], dir, { interactive: true })
    if (!(await loggedIn(dir))) throw new Error('Not logged in to Cloudflare yet. Run grndwrk relay deploy again and finish the login in the browser.')
  }

  console.log('\n3. Putting the relay on your account.')
  console.log('   The first time, Cloudflare asks "Would you like to register a workers.dev subdomain now?". Answer Y, then type a short name, such as')
  console.log('   your company\'s or your own. It becomes part of the relay\'s address (https://' + worker + '.<the name>.workers.dev), is free, and is')
  console.log('   your account\'s one name for everything you put on Cloudflare, so pick one you are happy to keep.\n')
  const report = join(dir, 'deploy-output.ndjson')
  await rm(report, { force: true })
  // Run as a normal command, so Cloudflare can ask what it needs; it writes where the relay runs to this file.
  await run(['--no-install', 'wrangler', 'deploy'], dir, { interactive: true, env: { WRANGLER_OUTPUT_FILE_PATH: report } })
  const url = relayOrigin(await deployedAt(report))

  // The owner key stays on this Mac; the relay gets only a key made from it, to check that mailboxes are opened by you.
  const owner = had?.owner ?? randomKey()
  console.log('\nGiving the relay its owner key: only this Mac can open mailboxes on it...')
  await run(['--no-install', 'wrangler', 'secret', 'put', 'OWNER_AUTH'], dir, { input: ownerAuthKey(owner), quiet: true })
  await saveOwnRelay({ url, owner, name: worker })

  const hello = await fetch(`${url}/v1/hello`).then((r) => r.json() as Promise<{ relay?: string }>).catch(() => ({ relay: undefined }))
  console.log(hello.relay === 'grndwrk' ? `\nDone. Your relay runs at ${url}.` : `\nDone. Your relay is at ${url}; it may take a minute before it answers.`)
  console.log('\nNext, in each project whose colleagues should send through it:\n  grndwrk relay add')
}

/** assets.ts for the relay's copy: the button, its way through the relay, and the picture library, as text. */
export async function relayAssets(): Promise<string> {
  const read = (...p: string[]) => readFile(join(PACKAGE_ROOT, ...p), 'utf8')
  const shot = await read('dist', 'vendor', 'modern-screenshot.js').catch(() => '')
  return [
    '// Written by grndwrk relay deploy, from the grndwrk that deployed this relay.',
    `export const OVERLAY = ${JSON.stringify(await read('overlay', 'feedback.js'))}`,
    `export const RELAY = ${JSON.stringify(await read('overlay', 'relay.js'))}`,
    `export const SHOT = ${JSON.stringify(shot)}`,
    '',
  ].join('\n')
}

/** The staging site whose browsers may join and send comments through the relay, or off. */
async function site(gwDir: string, arg: string | undefined) {
  const r = await projectRelay(gwDir)
  if (!r) throw new Error('This project does not use a relay yet: grndwrk relay add (or join) first.')
  const client = RelayClient.team(r.url, r.mailbox, r.team)
  if (!arg) {
    const { site: said } = await client.json<{ site?: string }>('GET', '/sync')
    // Printed in the terminal: only an origin, never whatever the relay sent.
    const now = typeof said === 'string' ? siteOrigin(said) : ''
    if (!now) return void console.log('No staging site yet. grndwrk relay site https://staging.example.com lets colleagues comment from it.')
    return printSiteLine(r, now)
  }
  if (arg === 'off') {
    await client.json('PUT', '/site', { site: '' })
    return void console.log('Done: the relay no longer serves the Comment button to the staging site, and takes nothing from its browsers. Remove the line from its layout.')
  }
  const wanted = siteOrigin(arg)
  if (!wanted) throw new Error('The staging site is an https address, like https://staging.example.com')
  await client.json('PUT', '/site', { site: wanted })
  const set = wanted
  console.log(`Colleagues can comment from ${set} once they join with an invite (the map: the globe at the bottom of the rail, Colleagues, Invite).`)
  printSiteLine(r, set)
}

function printSiteLine(r: { url: string; mailbox: string }, site: string) {
  console.log(`\nAdd this line to the staging site's layout, and only there (in Laravel inside @env('staging')):\n  <script src="${r.url}/v1/${r.mailbox}/feedback.js" defer></script>`)
  console.log(`\nThe button runs only on ${site}, and the relay serves it to no other site. If the site sends a Content-Security-Policy, it must allow ${r.url} in script-src and connect-src.`)
  console.log('A relay deployed with an older grndwrk serves no button: run grndwrk relay deploy once to update it.')
}

async function add(gwDir: string) {
  const own = await ownRelay()
  if (!own) throw new Error('No relay of yours on this Mac. Run grndwrk relay deploy first, or grndwrk relay join <team link> to use a teammate\'s.')
  const had = await projectRelay(gwDir)
  if (had) {
    console.log(`This project already has a mailbox at ${had.url}.`)
    return printTeamLink(had)
  }
  const r = { url: own.url, mailbox: randomId(), team: randomKey() }
  await RelayClient.owner(r.url, r.mailbox, own.owner).json('PUT', '', { team: teamAuthKey(r.team) })
  await saveProjectRelay(gwDir, r)
  console.log(`This project has a mailbox at ${r.url}. Restart grndwrk, then invite colleagues in the map: the globe at the bottom of the rail.`)
  printTeamLink(r)
}

async function join_(gwDir: string, link: string | undefined) {
  if (!link) throw new Error('Usage: grndwrk relay join <team link>. A teammate gets it with grndwrk relay in the project.')
  const { url, mailbox, secret } = parseLink(link, 'team')
  const r = { url, mailbox, team: secret }
  // A link that does not open the mailbox is refused here, not at the first comment.
  await RelayClient.team(url, mailbox, secret).json('GET', '/invites')
  await saveProjectRelay(gwDir, r)
  console.log(`Connected: this project's comments from colleagues come through ${url}. Restart grndwrk if it runs. The team key is kept on this Mac, not in the project.`)
}

async function status(gwDir: string) {
  const r = await projectRelay(gwDir)
  if (!r) {
    const own = await ownRelay()
    console.log(own ? `Your relay runs at ${own.url}, but this project has no mailbox there. grndwrk relay add gives it one.` : 'This project does not use a relay.\n')
    if (!own) console.log(RELAY_HELP)
    return
  }
  console.log(`Colleagues' comments come through ${r.url}, while grndwrk runs. Teammates connect with the team link: grndwrk relay link.`)
}

function printTeamLink(r: { url: string; mailbox: string; team: string }) {
  console.log(`\nTeammates connect their grndwrk with (send it privately; it opens the project's comments):\n  grndwrk relay join ${teamLink(r)}`)
}

/** Whether wrangler has a Cloudflare login (or an API token) to use. */
async function loggedIn(dir: string): Promise<boolean> {
  const said = await run(['--no-install', 'wrangler', 'whoami'], dir, { quiet: true }).catch(() => '')
  return /You are logged in/.test(said)
}

/** Where wrangler says the relay runs: the workers.dev address in its report. */
export async function deployedAt(report: string): Promise<string> {
  const lines = (await readFile(report, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  for (const line of lines.reverse()) {
    try {
      const entry = JSON.parse(line) as { type?: string; targets?: unknown }
      const targets = Array.isArray(entry.targets) ? entry.targets.filter((t): t is string => typeof t === 'string') : []
      const found = targets.find((t) => /^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/.test(t)) ?? targets.find((t) => t.startsWith('https://'))
      if (entry.type === 'deploy' && found) return found
    } catch {}
  }
  throw new Error('Cloudflare did not say where the relay runs. If it stopped to ask something (a workers.dev name), answer it and run grndwrk relay deploy again: it picks up where it left off.')
}

interface RunOptions {
  tool?: 'npx' | 'npm'
  /** Its own terminal, so it can ask questions and open the browser. Nothing is captured. */
  interactive?: boolean
  /** Said only if it fails. */
  quiet?: boolean
  /** Written to it: a secret, never on the command line. */
  input?: string
  env?: Record<string, string>
}

/** Runs npx or npm in `cwd`; returns what it printed, unless interactive. */
function run(args: string[], cwd: string, opts: RunOptions = {}): Promise<string> {
  const tool = opts.tool ?? 'npx'
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? `${tool}.cmd` : tool, args, {
      cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.interactive ? 'inherit' : [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      if (!opts.quiet) process.stdout.write(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      out += d.toString()
      if (!opts.quiet) process.stderr.write(d)
    })
    if (opts.input !== undefined) child.stdin!.end(opts.input + '\n')
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(out)
      if (opts.quiet && out.trim()) process.stderr.write(out)
      reject(new Error(`${tool === 'npm' ? 'Installing wrangler' : `wrangler ${args.filter((a) => !a.startsWith('-'))[1] ?? ''}`.trim()} stopped (exit ${code}). What it said is above.`))
    })
  })
}
