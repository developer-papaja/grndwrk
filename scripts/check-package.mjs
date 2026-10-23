// Checks the package as a user gets it, not the repo: packs it, installs
// the tarball into an empty folder (only its runtime dependencies, nothing
// from this repo's node_modules), then runs `grndwrk init` in an empty
// project and starts the map. Catches what works here but breaks for users:
// a file left out of `files`, a runtime import of a dev dependency, a stale
// build. Run after `npm run build`: node scripts/check-package.mjs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 7790
const win = process.platform === 'win32'
const npm = (args, cwd) => execFileSync(win ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'inherit'] })
const fail = (why) => {
  console.error(`Package check failed: ${why}`)
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'grndwrk-package-'))
let server
try {
  // 1. Pack it, as npm publish would (the build is already done).
  const tarball = join(tmp, npm(['pack', '--ignore-scripts', '--silent', '--pack-destination', tmp], process.cwd()).trim().split('\n').pop())
  if (!existsSync(tarball)) fail(`npm pack wrote no tarball (${tarball})`)

  // 2. Install it on its own, like npm install -g does.
  const prefix = join(tmp, 'prefix')
  npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], tmp)
  const root = win ? join(prefix, 'node_modules', 'grndwrk') : join(prefix, 'lib', 'node_modules', 'grndwrk')
  const bin = join(root, 'bin', 'grndwrk.js')
  const shim = win ? join(prefix, 'grndwrk.cmd') : join(prefix, 'bin', 'grndwrk')
  if (!existsSync(shim)) fail(`the grndwrk command was not installed (${shim})`)

  // 3. What the tool needs at runtime is in the package.
  const needed = ['dist/cli.js', 'dist/ui/index.html', 'dist/vendor/modern-screenshot.js', 'overlay/feedback.js', 'templates/CLAUDE.md', 'templates/checklist.md', 'commands/personas.md', 'commands/readiness.md', 'clients/ios/GrndwrkFeedback/Package.swift']
  for (const file of needed) if (!existsSync(join(root, file))) fail(`${file} is not in the package (see "files" in package.json)`)
  const deps = readdirSync(join(root, 'node_modules')).filter((d) => !d.startsWith('.'))
  console.log(`Installed with ${deps.length} packages beside it: ${deps.join(', ')}`)

  // 4. It runs: help, init in an empty project, and the map answers.
  const run = (args, cwd) => execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!run(['--help'], tmp).includes('grndwrk init')) fail('grndwrk --help printed no usage')
  const project = join(tmp, 'project')
  mkdirSync(project)
  run(['init'], project)
  for (const file of ['.grndwrk/project.md', '.grndwrk/CLAUDE.md', '.claude/commands/personas.md', '.agents/skills/readiness/SKILL.md']) {
    if (!existsSync(join(project, file))) fail(`grndwrk init did not write ${file}`)
  }

  server = spawn(process.execPath, [bin, 'start', '--no-open', '--port', String(PORT)], { cwd: project, stdio: 'inherit' })
  const get = async (path) => {
    for (let i = 0; i < 60; i++) {
      try {
        return await fetch(`http://localhost:${PORT}${path}`)
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    fail(`the map did not answer on port ${PORT}`)
  }
  const page = await get('/')
  if (page.status !== 200 || !(await page.text()).includes('<title>grndwrk</title>')) fail(`the map page answered ${page.status}`)
  for (const path of ['/api/project', '/api/nodes', '/api/screens', '/api/personas', '/api/segments']) {
    const res = await get(path)
    if (res.status !== 200) fail(`${path} answered ${res.status}`)
  }
  console.log('Package check passed: installed on its own, init wrote the map and the commands, the map answers.')
} finally {
  server?.kill()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
