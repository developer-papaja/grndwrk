import { execFile } from 'node:child_process'
import { lstat, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from './store/fs.js'
import { keepOutOfGit } from './store/gitignore.js'
import { basename, join, relative } from 'node:path'
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

  await moveOldFolder(projectRoot)
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
  const commandsDest = join(projectRoot, '.claude', 'commands')
  await mkdir(commandsDest, { recursive: true })
  // What init installed, by hash, so a later run can tell an untouched command from an edited one.
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
  for (const file of (await readdir(commandsSrc)).filter((f) => f.endsWith('.md')).sort()) {
    const shipped = await readFile(join(commandsSrc, file), 'utf8')
    const dest = join(commandsDest, file)
    const current = await readFile(dest, 'utf8').catch(() => null)
    if (current === null) {
      await writeFile(dest, shipped)
      say('created', dest)
    } else if (current === shipped) {
      say('ok', dest)
    } else if (installed[file] && installed[file] !== hash(current)) {
      // Changed by the person since init put it there: theirs wins.
      say('kept', dest)
      console.log('           you changed it, so it was not updated')
      continue
    } else {
      if (!installed[file]) {
        // Installed before init kept track: keep a copy, in case it was changed by hand.
        const backup = join(gw, 'backup', 'commands', file)
        await mkdir(join(gw, 'backup', 'commands'), { recursive: true })
        await writeFile(backup, current)
      }
      await writeFile(dest, shipped)
      say('updated', dest)
    }
    installed[file] = hash(shipped)
  }
  // The rules for working with the map, read by Claude Code whenever it opens a
  // file in .grndwrk/: a comment fixed without /feedback still becomes ready to test.
  const rules = await readFile(join(templates, 'CLAUDE.md'), 'utf8')
  const rulesPath = join(gw, 'CLAUDE.md')
  const currentRules = await readFile(rulesPath, 'utf8').catch(() => null)
  // Recorded under the folder's name before the rename to grndwrk.
  const OLD_KEY = `${OLD_GW_DIR}/CLAUDE.md`
  if (installed[OLD_KEY]) {
    installed['.grndwrk/CLAUDE.md'] ??= installed[OLD_KEY]
    delete installed[OLD_KEY]
  }
  if (currentRules === null) {
    await writeFile(rulesPath, rules)
    say('created', rulesPath)
  } else if (currentRules === rules) {
    say('ok', rulesPath)
  } else if (installed['.grndwrk/CLAUDE.md'] !== hash(currentRules)) {
    // Written by hand before, or changed since: kept. Claude Code follows this
    // file whenever it opens the map, so a change to it, also one that came
    // in a pull request, is worth a look.
    say('kept', rulesPath)
    console.log('           it differs from what grndwrk ships, so it was not updated.')
    console.log('           Claude follows it whenever it opens the map: check what it says (git log -p .grndwrk/CLAUDE.md).')
  } else {
    await writeFile(rulesPath, rules)
    say('updated', rulesPath)
  }
  if (currentRules === null || currentRules === rules || installed['.grndwrk/CLAUDE.md'] === hash(currentRules)) installed['.grndwrk/CLAUDE.md'] = hash(rules)
  await writeFile(manifestPath, JSON.stringify(installed, null, 2) + '\n')

  console.log(`\n${nextSteps(start)}\n\nAfter updating grndwrk, run \`grndwrk init\` again to update the commands.`)
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
        '  1. In Claude Code, run /survey. It reads the code, docs and history into the map.',
        '  2. Run /sitemap. It writes every screen: what it is for, who it is for, what they do there.',
        '  3. Run `grndwrk` to open the map. Status shows what the project has and what it lacks.',
      ].join('\n')
    : [
        'Done. This is a new project, so start from the idea:',
        '  1. Run `grndwrk` to open the map, write the purpose in one line, and capture what is on your mind.',
        '  2. In Claude Code, run /readiness to see what is missing, then answer it in Focus.',
        '  3. Run /brief for the brief, the first stories and the screens, and a CLAUDE.md to build with.',
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
async function moveOldFolder(projectRoot: string): Promise<void> {
  const old = join(projectRoot, OLD_GW_DIR)
  const st = await lstat(old).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isDirectory()) {
    console.log(`  skipped  ${OLD_GW_DIR}: a symbolic link or not a folder, so it was not moved\n`)
    return
  }
  if (await lstat(join(projectRoot, GW_DIR)).then(() => true, () => false)) {
    console.log(`  kept     ${OLD_GW_DIR}: ${GW_DIR}/ is there too, so nothing was moved. Keep the one you use.\n`)
    return
  }
  await rename(old, join(projectRoot, GW_DIR))
  console.log(`  moved    ${OLD_GW_DIR} to ${GW_DIR} (the name before grndwrk)\n`)
}
