import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { GW_DIR, PACKAGE_ROOT } from './root.js'
import { scalar } from './store/frontmatter.js'

/**
 * Create `.groundwork/` and copy the Claude Code commands. Run again after
 * updating Groundwork to update the commands too. Never overwrites the map,
 * and never overwrites a command the person changed.
 */
export async function init(projectRoot: string): Promise<void> {
  const gw = join(projectRoot, GW_DIR)
  const templates = join(PACKAGE_ROOT, 'templates')
  const say = (verb: string, path: string) => console.log(`  ${verb.padEnd(8)} ${relative(projectRoot, path)}`)

  for (const dir of ['nodes', 'stories', 'screens', 'readiness', 'outputs']) {
    await mkdir(join(gw, dir), { recursive: true })
  }

  const project = (await readFile(join(templates, 'project.md'), 'utf8')).replace('{{name}}', scalar(basename(projectRoot)))
  await writeOnce(join(gw, 'project.md'), project, say)
  await writeOnce(join(gw, 'readiness', 'checklist.md'), await readFile(join(templates, 'checklist.md'), 'utf8'), say)

  const commandsSrc = join(PACKAGE_ROOT, 'commands')
  const commandsDest = join(projectRoot, '.claude', 'commands')
  await mkdir(commandsDest, { recursive: true })
  // What init installed, by hash, so a later run can tell an untouched command from an edited one.
  const manifestPath = join(gw, 'commands.json')
  const installed: Record<string, string> = await readFile(manifestPath, 'utf8').then((t) => JSON.parse(t), () => ({}))
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
  await writeFile(manifestPath, JSON.stringify(installed, null, 2) + '\n')

  console.log('\nDone. Run `groundwork` to open the map. After updating Groundwork, run `groundwork init` again to update the commands.')
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

async function writeOnce(path: string, content: string, say: (verb: string, path: string) => void): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' })
    say('created', path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    say('skipped', path)
  }
}
