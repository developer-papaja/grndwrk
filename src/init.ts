import { execFile } from 'node:child_process'
import { lstat, readdir as readdirRaw, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from './store/fs.js'
import { keepOutOfGit } from './store/gitignore.js'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { GW_DIR, OLD_GW_DIR, PACKAGE_ROOT } from './root.js'
import { scalar } from './store/frontmatter.js'
import { readProject, writeFields } from './store/project.js'

export type Start = 'new' | 'existing'

/**
 * Create `.grndwrk/` and copy the Claude Code commands. Run again after
 * updating grndwrk to update the commands too. Never overwrites the map,
 * and never overwrites a command the person changed.
 */
export async function init(projectRoot: string, options: { ask?: (question: string) => Promise<string> } = {}): Promise<void> {
  const gw = join(projectRoot, GW_DIR)
  const templates = join(PACKAGE_ROOT, 'templates')
  const say = (verb: string, path: string) => console.log(`  ${verb.padEnd(8)} ${relative(projectRoot, path)}`)

  if (!(await moveOldFolder(projectRoot))) return
  for (const dir of ['nodes', 'stories', 'screens', 'readiness', 'outputs']) {
    await mkdir(join(gw, dir), { recursive: true })
  }
  // What belongs to this machine stays out of git from the start, before anything writes it.
  for (const entry of ['local.json', 'lan-code', 'shots/']) await keepOutOfGit(gw, entry)

  // New or existing decides the steps grndwrk guides through. Ask once; keep the answer.
  const known = (await readProject(gw)).data.start
  const start: Start = known === 'new' || known === 'existing' ? known : await decideStart(projectRoot, options.ask)
  const project = (await readFile(join(templates, 'project.md'), 'utf8')).replace('{{name}}', scalar(basename(projectRoot))).replace('{{start}}', start)
  if (!(await writeOnce(join(gw, 'project.md'), project, say)) && known !== start) await writeFields(gw, { start })
  await writeOnce(join(gw, 'readiness', 'checklist.md'), await readFile(join(templates, 'checklist.md'), 'utf8'), say)
  await dropRetiredAreas(join(gw, 'readiness', 'checklist.md'), say)

  const commandsSrc = join(PACKAGE_ROOT, 'commands')
  // What init installed, by hash, so a later run can tell an untouched file from an edited one.
  const manifestPath = join(gw, 'commands.json')
  const installed: Record<string, string> = await readFile(manifestPath, 'utf8').then(
    (t) => {
      try {
        const data = JSON.parse(t)
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
      } catch {
        return {}
      }
    },
    () => ({}),
  )
  // Recorded under the folder's name before the rename to grndwrk.
  const OLD_KEY = `${OLD_GW_DIR}/CLAUDE.md`
  if (installed[OLD_KEY]) {
    installed['.grndwrk/CLAUDE.md'] ??= installed[OLD_KEY]
    delete installed[OLD_KEY]
  }
  const install = (dest: string, shipped: string, key: string, unknown: Unknown) => installManaged({ dest, shipped, key, unknown, installed, gw, say })

  // The commands, for Claude Code (.claude/commands) and as skills for Codex,
  // Cursor and other agents that read .agents/skills (/readiness, or $readiness in Codex).
  for (const file of (await readdir(commandsSrc)).filter((f) => f.endsWith('.md')).sort()) {
    const shipped = await readFile(join(commandsSrc, file), 'utf8')
    await install(join(projectRoot, '.claude', 'commands', file), shipped, file, 'backup')
    const name = file.replace(/\.md$/, '')
    await install(join(projectRoot, '.agents', 'skills', name, 'SKILL.md'), asSkill(name, shipped, false), `.agents/skills/${name}`, 'keep')
  }
  // The rules for working with the map, read whenever an agent opens a file in
  // .grndwrk/: a comment fixed without /feedback still becomes ready to test.
  // Claude Code reads CLAUDE.md there, Cursor AGENTS.md; Codex reads AGENTS.md
  // only from the root down, so it gets them as a skill it picks up itself.
  const rules = await readFile(join(templates, 'CLAUDE.md'), 'utf8')
  for (const file of ['CLAUDE.md', 'AGENTS.md']) await install(join(gw, file), rules, `.grndwrk/${file}`, 'review')
  await install(join(projectRoot, '.agents', 'skills', 'grndwrk-map', 'SKILL.md'), asSkill('grndwrk-map', rules, true), '.agents/skills/grndwrk-map', 'review')
  await writeFile(manifestPath, JSON.stringify(installed, null, 2) + '\n')

  const rootAgents = await readFile(join(projectRoot, 'AGENTS.md'), 'utf8').catch(() => null)
  if (rootAgents !== null && !rootAgents.includes('.grndwrk')) {
    console.log('\n  Codex reads AGENTS.md only from the root down. To give it the map rules every time, add this line to AGENTS.md:')
    console.log('    When you work with anything in .grndwrk/, or fix something a comment or story there asks for, follow .grndwrk/AGENTS.md.')
  }

  console.log(`\n${nextSteps(start)}\n\nAfter updating grndwrk, run \`grndwrk init\` again to update the commands and skills.`)
}

/**
 * Checklist areas grndwrk no longer asks about, taken out of a project's
 * checklist when they still read exactly as shipped. A reworded one is the
 * person's own and stays.
 */
const RETIRED_AREAS = [
  // Scope: deciding what is in or out of a release is not this tool's job yet.
  '**Scope.** What is in the first version and what is explicitly out.\nEnough when: there is at least one thing you decided not to build.\n\n',
]

async function dropRetiredAreas(path: string, say: (verb: string, path: string) => void): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return
  const next = RETIRED_AREAS.reduce((t, area) => t.replace(area, ''), text)
  if (next === text) return
  await writeFile(path, next)
  say('updated', path)
  console.log('           took out Scope, which grndwrk no longer asks about')
}

/** What to do next, for a new idea or for a project that already has code. */
export function nextSteps(start: Start): string {
  return start === 'existing'
    ? [
        'Done. This is an existing project, so start from what is built:',
        '  1. In your coding agent, run /survey ($survey in Codex). It reads the code, docs and history into the map.',
        '  2. Run /sitemap. It writes every screen: what it is for, who it is for, what they do there.',
        '  3. Run `grndwrk` to open the map. Status shows what the project has and what it lacks.',
      ].join('\n')
    : [
        'Done. This is a new project, so start from the idea:',
        '  1. Run `grndwrk` to open the map, write the purpose in one line, and capture what is on your mind.',
        '  2. In your coding agent, run /readiness ($readiness in Codex) to see what is missing, then answer it in Focus.',
        '  3. Run /brief for the brief, the first stories and the screens, and a CLAUDE.md (or AGENTS.md) to build with.',
      ].join('\n')
}

/** Signs of code: a package or project file, a source folder, or a history of commits. */
export async function looksExisting(projectRoot: string): Promise<boolean> {
  const entries = await readdir(projectRoot).catch(() => [] as string[])
  const markers = ['package.json', 'Package.swift', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'composer.json', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'pubspec.yaml', 'src', 'app', 'lib', 'Sources']
  if (entries.some((e) => markers.includes(e) || e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace') || e.endsWith('.csproj') || e.endsWith('.sln'))) return true
  const commits = await new Promise<number>((done) =>
    execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: projectRoot }, (err, out) => done(err ? 0 : Number(out.trim()) || 0)),
  )
  return commits > 5
}

async function decideStart(projectRoot: string, ask?: (question: string) => Promise<string>): Promise<Start> {
  const guess: Start = (await looksExisting(projectRoot)) ? 'existing' : 'new'
  const prompt = ask ?? (process.stdin.isTTY ? askInTerminal : undefined)
  if (!prompt) {
    console.log(`  ${guess === 'existing' ? 'Found code here, so this counts as an existing project.' : 'No code here, so this counts as a new project.'} Change start: in .grndwrk/project.md if not.\n`)
    return guess
  }
  const answer = (await prompt(guess === 'existing' ? 'This folder has code. Is it an existing project you want to keep building? [Y/n] ' : 'Is this a new project, with nothing built yet? [Y/n] ')).trim().toLowerCase()
  const yes = answer === '' || answer.startsWith('y')
  console.log('')
  return yes ? guess : guess === 'existing' ? 'new' : 'existing'
}

async function askInTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(`  ${question}`)
  } finally {
    rl.close()
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Write a file only if it is not there yet. True when it was written. */
async function writeOnce(path: string, content: string, say: (verb: string, path: string) => void): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' })
    say('created', path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    say('skipped', path)
    return false
  }
}

/**
 * A map from before the rename to grndwrk lives in `.groundwork/`: move it to
 * `.grndwrk/`, as it is, so the map, its threads and its pictures come along.
 * Never through a symbolic link, and never over a `.grndwrk/` that is there.
 */
async function moveOldFolder(projectRoot: string): Promise<boolean> {
  const old = join(projectRoot, OLD_GW_DIR)
  const st = await lstat(old).catch(() => null)
  if (!st) return true
  if (st.isSymbolicLink() || !st.isDirectory()) {
    console.log(`  skipped  ${OLD_GW_DIR}: a symbolic link or not a folder, so it was not moved\n`)
    return true
  }
  if (await lstat(join(projectRoot, GW_DIR)).then(() => true, () => false)) {
    console.log(`  kept     ${OLD_GW_DIR}: ${GW_DIR}/ is there too, so nothing was moved. Keep the one you use.\n`)
    return true
  }
  // A link inside would be refused once moved, leaving a half set up map: say so first, and move nothing.
  const link = await firstLink(old)
  if (link) {
    console.log(`  skipped  ${OLD_GW_DIR}: ${relative(projectRoot, link)} is a symbolic link, so nothing was moved. Replace it with a real file or folder, then run init again.\n`)
    process.exitCode = 1
    return false
  }
  await rename(old, join(projectRoot, GW_DIR))
  console.log(`  moved    ${OLD_GW_DIR} to ${GW_DIR} (the name before grndwrk)\n`)
  return true
}

/** The first symbolic link anywhere inside a folder, or null. */
async function firstLink(dir: string): Promise<string | null> {
  for (const e of await readdirRaw(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) return p
    if (e.isDirectory()) {
      const found = await firstLink(p)
      if (found) return found
    }
  }
  return null
}

/** What to do with a file init did not write, or one the person changed: back it up and replace it, keep it, or keep it and say it is worth a look. */
type Unknown = 'backup' | 'keep' | 'review'

/**
 * Write a file grndwrk ships, unless the person changed it since init put it
 * there. A file that was there before init kept track is backed up and
 * replaced (commands), kept (a skill of the same name is someone else's), or
 * kept with a notice (rules an agent follows: a change, also one that came in
 * a pull request, is worth a look).
 */
async function installManaged(o: { dest: string; shipped: string; key: string; unknown: Unknown; installed: Record<string, string>; gw: string; say: (verb: string, path: string) => void }): Promise<void> {
  const { dest, shipped, key, unknown, installed, gw, say } = o
  const current = await readFile(dest, 'utf8').catch(() => null)
  if (current === null) {
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, shipped)
    say('created', dest)
  } else if (current === shipped) {
    say('ok', dest)
  } else if (installed[key] && installed[key] === hash(current)) {
    await writeFile(dest, shipped)
    say('updated', dest)
  } else if (installed[key] || unknown !== 'backup') {
    say('kept', dest)
    if (installed[key]) console.log('           you changed it, so it was not updated')
    else if (unknown === 'keep') console.log('           grndwrk did not write it, so it was left as it is')
    if (unknown === 'review') console.log(`           it differs from what grndwrk ships. Agents follow it whenever they open the map: check what it says (git log -p ${relative(join(gw, '..'), dest)}).`)
    return
  } else {
    // Installed before init kept track: keep a copy, in case it was changed by hand.
    const backup = join(gw, 'backup', 'commands', basename(dest))
    await mkdir(join(gw, 'backup', 'commands'), { recursive: true })
    await writeFile(backup, current)
    await writeFile(dest, shipped)
    say('updated', dest)
  }
  installed[key] = hash(shipped)
}

/**
 * A command as an Agent Skill (`.agents/skills/<name>/SKILL.md`), the format
 * Codex and Cursor read: `name` and `description` in the frontmatter, the
 * same instructions below. The commands run only when asked for; the map's
 * rules are picked up by the agent itself when it works in .grndwrk/.
 */
export function asSkill(name: string, text: string, rules: boolean): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = m ? text.slice(m[0].length) : text
  const description = rules
    ? 'Rules for the grndwrk map in .grndwrk/: thoughts, screens, stories and comments made in the running product. Use whenever you read or change anything in .grndwrk/, or fix, build or change something a comment or a story there asks for.'
    : (/^description:\s*(.+)$/m.exec(m?.[1] ?? '')?.[1].trim() ?? `The grndwrk ${name} command`)
  return `---\nname: ${name}\ndescription: ${scalar(description)}\n${rules ? '' : 'disable-model-invocation: true\n'}---\n${body}`
}
