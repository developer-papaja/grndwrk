import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { GW_DIR, PACKAGE_ROOT } from './root.js'
import { scalar } from './store/frontmatter.js'

/** Create `.groundwork/` and copy the Claude Code commands. Never overwrites anything. */
export async function init(projectRoot: string): Promise<void> {
  const gw = join(projectRoot, GW_DIR)
  const templates = join(PACKAGE_ROOT, 'templates')
  const say = (verb: string, path: string) => console.log(`  ${verb.padEnd(8)} ${relative(projectRoot, path)}`)

  for (const dir of ['nodes', 'stories', 'readiness', 'outputs']) {
    await mkdir(join(gw, dir), { recursive: true })
  }

  const project = (await readFile(join(templates, 'project.md'), 'utf8')).replace('{{name}}', scalar(basename(projectRoot)))
  await writeOnce(join(gw, 'project.md'), project, say)
  await writeOnce(join(gw, 'readiness', 'checklist.md'), await readFile(join(templates, 'checklist.md'), 'utf8'), say)

  const commandsSrc = join(PACKAGE_ROOT, 'commands')
  const commandsDest = join(projectRoot, '.claude', 'commands')
  await mkdir(commandsDest, { recursive: true })
  for (const file of (await readdir(commandsSrc)).filter((f) => f.endsWith('.md')).sort()) {
    await writeOnce(join(commandsDest, file), await readFile(join(commandsSrc, file), 'utf8'), say)
  }

  console.log('\nDone. Run `groundwork` to open the map.')
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
