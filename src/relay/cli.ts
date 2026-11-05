/**
 * `grndwrk relay ...`: set up the team's relay on Cloudflare, give a project
 * a mailbox there, and connect a teammate's grndwrk to it.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_ROOT, stateDir } from '../root.js'
import { RelayClient } from './client.js'
import { ownRelay, parseLink, projectRelay, relayOrigin, saveOwnRelay, saveProjectRelay, teamLink } from './config.js'
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
  for (const f of ['package.json', 'package-lock.json']) await cp(join(PACKAGE_ROOT, 'relay', f), join(dir, f), { force: true })
  const toml = await readFile(join(PACKAGE_ROOT, 'relay', 'wrangler.toml'), 'utf8')
  await writeFile(join(dir, 'wrangler.toml'), toml.replace(/^name = ".*"$/m, `name = "${worker}"`))

  console.log(`Putting the relay on your Cloudflare account as ${worker}, with ${WRANGLER}. The first time, Cloudflare asks you to log in in the browser.\n`)
  console.log('Installing it, exactly as locked...')
  await run(['ci', '--no-audit', '--no-fund'], dir, undefined, 'npm')
  const out = await run(['--no-install', 'wrangler', 'deploy'], dir)
  const found = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0]
  if (!found) throw new Error('Cloudflare did not say where the relay runs. If it asked you to pick a workers.dev subdomain, do that and run grndwrk relay deploy again.')
  const url = relayOrigin(found)

  // The owner key stays on this Mac; the relay gets only a key made from it, to check that mailboxes are opened by you.
  const owner = had?.owner ?? randomKey()
  console.log('\nGiving the relay its owner key...')
  await run(['--no-install', 'wrangler', 'secret', 'put', 'OWNER_AUTH'], dir, ownerAuthKey(owner))
  await saveOwnRelay({ url, owner, name: worker })

  const hello = await fetch(`${url}/v1/hello`).then((r) => r.json() as Promise<{ relay?: string }>).catch(() => ({ relay: undefined }))
  console.log(hello.relay === 'grndwrk' ? `\nThe relay runs at ${url}.` : `\nThe relay is deployed at ${url}; it may take a minute to answer.`)
  console.log('Next, in each project that should use it: grndwrk relay add')
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

/** Runs npx; prints what it says and returns it. Input, when given, is written to it (a secret: never on the command line). */
function run(args: string[], cwd: string, input?: string, tool: 'npx' | 'npm' = 'npx'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? `${tool}.cmd` : tool, args, { cwd, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    let out = ''
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      process.stdout.write(d)
    })
    if (input !== undefined) child.stdin!.end(input + '\n')
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.slice(1, 3).join(' ')} stopped (exit ${code}). See above.`))))
  })
}
