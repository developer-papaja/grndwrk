import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { lstat, readdir as readdirRaw, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from './store/fs.js'
import { keepOutOfGit } from './store/gitignore.js'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { GW_DIR, OLD_GW_DIR, PACKAGE_ROOT } from './root.js'
import { scalar } from './store/frontmatter.js'
import { readProject, writeFields } from './store/project.js'
import { setPersonalInfo } from './store/waiting.js'
import { personalInfo } from './shared/waiting.js'
import { SYNCED_FILES, SYNCED_FOLDERS } from './shared-store/protocol.js'

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
  for (const entry of ['local.json', 'lan-code', 'lan-devices.json', 'shots/', 'store-sync.json']) await keepOutOfGit(gw, entry)
  // Where the map is kept: asked once, for a map not started yet, so one from the store comes in before anything is written.
  const fresh = !(await exists(join(gw, 'project.md'))) && !(await exists(join(gw, 'store.json')))
  if (fresh) await decideStore(projectRoot, gw, options.ask)

  // New or existing decides the steps grndwrk guides through. Ask once; keep the answer.
  const known = (await readProject(gw)).data.start
  const start: Start = known === 'new' || known === 'existing' ? known : await decideStart(projectRoot, options.ask)
  const project = (await readFile(join(templates, 'project.md'), 'utf8')).replace('{{name}}', scalar(basename(projectRoot))).replace('{{start}}', start)
  if (!(await writeOnce(join(gw, 'project.md'), project, say)) && known !== start) await writeFields(gw, { start })
  await decidePersonalInfo(gw, options.ask)
  await writeOnce(join(gw, 'readiness', 'checklist.md'), await readFile(join(templates, 'checklist.md'), 'utf8'), say)
  await dropRetiredAreas(join(gw, 'readiness', 'checklist.md'), say)

  // What init installed, by hash, so a later run can tell an untouched file from an edited one.
  const manifestPath = join(gw, 'commands.json')
  const installed = await readInstalled(gw)
  const install = (dest: string, shipped: string, key: string, unknown: Unknown) => installManaged({ dest, shipped, key, unknown, installed, gw, say })
  for (const f of await managedFiles(projectRoot)) await install(f.dest, f.shipped, f.key, f.unknown)
  await addRootRules(projectRoot, installed, say, options.ask)
  // Which grndwrk installed them, so a later grndwrk can say they are older than it (src/updates.ts).
  installed[VERSION_KEY] = packageVersion()
  await writeFile(manifestPath, JSON.stringify(installed, null, 2) + '\n')

  console.log(`\n${nextSteps(start)}\n\nAfter updating grndwrk, run \`grndwrk init\` again to update the commands and skills.`)
}

/** The key in commands.json naming the grndwrk version that last installed the files. */
export const VERSION_KEY = 'grndwrk'

export function packageVersion(): string {
  return String(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '')
}

/** What init installed, by hash (`.grndwrk/commands.json`), and which grndwrk did. */
export async function readInstalled(gw: string): Promise<Record<string, string>> {
  const installed: Record<string, string> = await readFile(join(gw, 'commands.json'), 'utf8').then(
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
  return installed
}

/**
 * Every file init writes and keeps up to date, with what this grndwrk ships
 * for it: the commands for Claude Code (.claude/commands) and as skills for
 * Codex, Cursor and other agents that read .agents/skills (/readiness, or
 * $readiness in Codex), and the rules for working with the map, read whenever
 * an agent opens a file in .grndwrk/ (Claude Code reads CLAUDE.md there,
 * Cursor AGENTS.md; Codex reads AGENTS.md only from the root down, so it gets
 * them as a skill it picks up itself).
 */
export async function managedFiles(projectRoot: string): Promise<{ dest: string; shipped: string; key: string; unknown: Unknown }[]> {
  const gw = join(projectRoot, GW_DIR)
  const commandsSrc = join(PACKAGE_ROOT, 'commands')
  const files: { dest: string; shipped: string; key: string; unknown: Unknown }[] = []
  for (const file of (await readdir(commandsSrc)).filter((f) => f.endsWith('.md')).sort()) {
    const shipped = await readFile(join(commandsSrc, file), 'utf8')
    const name = file.replace(/\.md$/, '')
    files.push({ dest: join(projectRoot, '.claude', 'commands', file), shipped, key: file, unknown: 'backup' })
    files.push({ dest: join(projectRoot, '.agents', 'skills', name, 'SKILL.md'), shipped: asSkill(name, shipped, false), key: `.agents/skills/${name}`, unknown: 'keep' })
  }
  const rules = await readFile(join(PACKAGE_ROOT, 'templates', 'CLAUDE.md'), 'utf8')
  for (const file of ['CLAUDE.md', 'AGENTS.md']) files.push({ dest: join(gw, file), shipped: rules, key: `.grndwrk/${file}`, unknown: 'review' })
  files.push({ dest: join(projectRoot, '.agents', 'skills', 'grndwrk-map', 'SKILL.md'), shipped: asSkill('grndwrk-map', rules, true), key: '.agents/skills/grndwrk-map', unknown: 'review' })
  return files
}

const ROOT_START = '<!-- grndwrk: the map, for your agent. grndwrk init keeps this block up to date unless you change it. -->'
const ROOT_END = '<!-- /grndwrk -->'

/**
 * The block for the project's own CLAUDE.md (and AGENTS.md). The map's rules
 * sit in `.grndwrk/CLAUDE.md`, which Claude Code reads only once it opens a
 * file in `.grndwrk/`: in an ordinary chat about the code it never would, and
 * never learn the map is there. This puts the map in front of it in every chat.
 */
export function rootRules(rulesFile: string): string {
  return [
    ROOT_START,
    '## grndwrk',
    '',
    `This project has a grndwrk map in \`.grndwrk/\`: thoughts, screens, stories, and comments people made in the running product. Read \`.grndwrk/${rulesFile}\` before you change anything in the project, and follow it whatever you were asked:`,
    '',
    '- Mark what you build or fix as built, with steps to test, and end each step you checked yourself in `[automated: <test>]` or `[agent: <how>]`. Never settle it yourself.',
    '- Put every question you ask the person into the map, as a question in a thread, never only in the chat.',
    '- Tick the stories you build against, and cite their ids in commit messages.',
    '- Before you start on a screen or a feature, say the first item in `.grndwrk/readiness/focus/` that is not set aside.',
    '',
    'At the end of a piece of work, ask once whether to write the decisions from it into the map (`/decisions`), and write them only if the person says yes.',
    ROOT_END,
    '',
  ].join('\n')
}

/**
 * Asks once whether to put the map's rules in the project's root CLAUDE.md
 * (and AGENTS.md, when there is one): the only files outside `.grndwrk/` and
 * the agent folders grndwrk writes, and only after a yes. A block written
 * before is updated while it reads as written; one the person changed stays.
 * Without a terminal, or after a no, the block is printed to add by hand.
 */
async function addRootRules(projectRoot: string, installed: Record<string, string>, say: (verb: string, path: string) => void, ask?: (question: string) => Promise<string>): Promise<void> {
  const files: { name: string; rules: string }[] = [{ name: 'CLAUDE.md', rules: 'CLAUDE.md' }]
  if ((await readFile(join(projectRoot, 'AGENTS.md'), 'utf8').catch(() => null)) !== null) files.push({ name: 'AGENTS.md', rules: 'AGENTS.md' })
  const missing: { name: string; rules: string; text: string | null }[] = []
  for (const f of files) {
    const path = join(projectRoot, f.name)
    // Never written through a link: it could point anywhere.
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) continue
    const text = await readFile(path, 'utf8').catch(() => null)
    const shipped = rootRules(f.rules)
    const at = text?.indexOf(ROOT_START) ?? -1
    if (text !== null && at >= 0) {
      const end = text.indexOf(ROOT_END, at)
      const block = end >= 0 ? text.slice(at, end + ROOT_END.length) + '\n' : ''
      // Updated only while it reads exactly as grndwrk wrote it.
      if (block && block !== shipped && hash(block) === installed[`root:${f.name}`]) {
        await writeFile(path, text.slice(0, at) + shipped + text.slice(end + ROOT_END.length + 1))
        say('updated', path)
      }
      if (block === shipped || hash(block) === installed[`root:${f.name}`]) installed[`root:${f.name}`] = hash(shipped)
      continue
    }
    missing.push({ ...f, text })
  }
  if (!missing.length) return
  const names = missing.map((f) => f.name).join(' and ')
  const prompt = ask ?? (process.stdin.isTTY ? askInTerminal : undefined)
  let yes = false
  if (prompt && installed['root:answer'] !== 'no') {
    const answer = (await prompt(`Add the map's rules to ${names} at the root of the project, so your agent follows them in every chat, not only when it opens .grndwrk/? [Y/n] `)).trim().toLowerCase()
    console.log('')
    yes = answer === '' || answer.startsWith('y')
    installed['root:answer'] = yes ? 'yes' : 'no'
  }
  if (!yes) {
    console.log(`\n  Your agent sees the map's rules only when it opens a file in .grndwrk/. To have them in every chat, add this to ${names} at the root:\n`)
    console.log(rootRules(missing[0].rules).replace(/^/gm, '    '))
    return
  }
  for (const f of missing) {
    const path = join(projectRoot, f.name)
    const shipped = rootRules(f.rules)
    await writeFile(path, f.text === null ? shipped : `${f.text.replace(/\s*$/, '')}\n\n${shipped}`)
    installed[`root:${f.name}`] = hash(shipped)
    say(f.text === null ? 'created' : 'updated', path)
  }
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
        '  2. Run /sitemap. It writes every screen: what it is for, who it is for, what they do there. Then /personas for the people it is for.',
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

/**
 * Whether the map may hold people's names (who a question waits for). Asked
 * once, when there is someone to ask; without an answer the names stay on
 * this Mac, and the map asks the first time someone picks a name.
 */
async function decidePersonalInfo(gw: string, ask?: (question: string) => Promise<string>): Promise<void> {
  if (personalInfo((await readProject(gw)).data)) return
  const prompt = ask ?? (process.stdin.isTTY ? askInTerminal : undefined)
  if (!prompt) return
  const answer = (await prompt('May the map hold people\'s names, such as who a question waits for? Say no if the repository is public. [y/N] ')).trim().toLowerCase()
  console.log('')
  await setPersonalInfo(gw, answer.startsWith('y') ? 'yes' : 'no')
}

const exists = (path: string) => readFile(path).then(() => true, () => false)

/**
 * In this repository, as always, or in the team's store (docs/store-protocol.md).
 * Only asked of a person at a terminal. With a store, the map may also be left
 * out of git: that is the project's choice, so it goes in .grndwrk/.gitignore.
 */
async function decideStore(projectRoot: string, gw: string, ask?: (question: string) => Promise<string>): Promise<void> {
  const prompt = ask ?? (process.stdin.isTTY ? askInTerminal : undefined)
  if (!prompt) return
  const where = (await prompt("Where is the map kept? In this repository (1), or in your team's store (2)? [1] ")).trim().toLowerCase()
  console.log('')
  if (!(where === '2' || where.startsWith('s') || where.startsWith('t'))) return
  const target = (await prompt("The store's address (https://...), or its adapter file in this repository (.mjs): ")).trim()
  if (!target) return void console.log('  No store given, so the map is kept in this repository. Later: grndwrk store use <url | adapter.mjs>\n')
  const { useStore, syncOnce } = await import('./shared-store/cli.js')
  if (!(await useStore(projectRoot, target))) return
  if ((await prompt('Leave the map out of git, so the store is where it is kept? store.json and the agent rules stay in the repository. [y/N] ')).trim().toLowerCase().startsWith('y')) {
    for (const entry of [...SYNCED_FILES, ...SYNCED_FOLDERS.map((f) => `${f}/`)]) await keepOutOfGit(gw, `/${entry}`)
    console.log('  The map is in .grndwrk/.gitignore now. Files git already tracks stay tracked until: git rm -r --cached <them>')
  }
  // The team's map comes in first, so what init writes next does not stand in its way.
  await syncOnce(projectRoot, gw)
  console.log('')
}

async function askInTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(`  ${question}`)
  } finally {
    rl.close()
  }
}

export function hash(text: string): string {
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
export type Unknown = 'backup' | 'keep' | 'review'

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
  // Git on Windows may check the shipped commands out with CRLF line ends.
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = m ? text.slice(m[0].length) : text
  const description = rules
    ? 'Rules for the grndwrk map in .grndwrk/: thoughts, screens, stories and comments made in the running product. Use whenever you read or change anything in .grndwrk/, or fix, build or change something a comment or a story there asks for.'
    : (/^description:\s*(.+)$/m.exec(m?.[1] ?? '')?.[1].trim() ?? `The grndwrk ${name} command`)
  return `---\nname: ${name}\ndescription: ${scalar(description)}\n${rules ? '' : 'disable-model-invocation: true\n'}---\n${body}`
}
