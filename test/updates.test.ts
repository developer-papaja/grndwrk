import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hash, init, packageVersion } from '../src/init.js'
import { isNewer, latestVersion, npmNotice, outdatedRules, rulesNotice, updateCheckOff } from '../src/updates.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-updates-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const manifest = () => join(root, '.grndwrk', 'commands.json')

describe('rules older than this grndwrk', () => {
  it('says nothing right after init, and records which grndwrk installed them', async () => {
    await init(root)
    expect((await outdatedRules(root)).files).toEqual([])
    expect(JSON.parse(await readFile(manifest(), 'utf8')).grndwrk).toBe(packageVersion())
  })

  it('lists a file init wrote and nobody changed, when this grndwrk ships another', async () => {
    await init(root)
    // As an older grndwrk left it: other words, recorded as installed.
    const old = 'Older rules.\n'
    await writeFile(join(root, '.grndwrk', 'CLAUDE.md'), old)
    const m = JSON.parse(await readFile(manifest(), 'utf8'))
    await writeFile(manifest(), JSON.stringify({ ...m, '.grndwrk/CLAUDE.md': hash(old), grndwrk: '0.4.1' }))
    const out = await outdatedRules(root)
    expect(out).toEqual({ files: ['.grndwrk/CLAUDE.md'], installedBy: '0.4.1' })
    expect(rulesNotice(out, '0.4.3')).toMatch(/older than this grndwrk \(0\.4\.3, installed by grndwrk 0\.4\.1\): 1 file\. Run grndwrk init/)
  })

  it('leaves out a file the person changed, and one they deleted', async () => {
    await init(root)
    await writeFile(join(root, '.grndwrk', 'CLAUDE.md'), 'My own rules.\n')
    await unlink(join(root, '.claude', 'commands', 'readiness.md'))
    expect((await outdatedRules(root)).files).toEqual([])
  })

  it('lists a command new in this grndwrk', async () => {
    await init(root)
    await unlink(join(root, '.claude', 'commands', 'readiness.md'))
    const m = JSON.parse(await readFile(manifest(), 'utf8'))
    delete m['readiness.md']
    await writeFile(manifest(), JSON.stringify(m))
    expect((await outdatedRules(root)).files).toEqual(['.claude/commands/readiness.md'])
  })
})

describe('a newer grndwrk on npm', () => {
  const env = {} as NodeJS.ProcessEnv
  const answer = (version: unknown) => vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch

  it('asks at most once a day, and keeps the answer', async () => {
    const file = join(root, 'update-check.json')
    const f = answer('0.9.0')
    expect(await latestVersion({ file, now: 1000, fetch: f, env, root })).toBe('0.9.0')
    expect(await latestVersion({ file, now: 2000, fetch: f, env, root })).toBe('0.9.0')
    expect(f).toHaveBeenCalledTimes(1)
    await latestVersion({ file, now: 1000 + 25 * 3600_000, fetch: f, env, root })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing that is not a plain version, and survives npm being away', async () => {
    const file = join(root, 'update-check.json')
    expect(await latestVersion({ file, now: 1, fetch: answer('\u001b[31m9.9.9'), env, root })).toBeNull()
    const away = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await latestVersion({ file, now: 1 + 25 * 3600_000, fetch: away, env, root })).toBeNull()
  })

  it('is never asked when turned off, in CI, or from the source', async () => {
    const f = answer('0.9.0')
    const file = join(root, 'update-check.json')
    expect(await latestVersion({ file, fetch: f, env: { GRNDWRK_NO_UPDATE_CHECK: '1' }, root })).toBeNull()
    expect(await latestVersion({ file, fetch: f, env: { NO_UPDATE_NOTIFIER: '1' }, root })).toBeNull()
    expect(await latestVersion({ file, fetch: f, env: { CI: 'true' }, root })).toBeNull()
    expect(updateCheckOff({}, join(__dirname, '..'))).toBe('running from the source')
    expect(updateCheckOff({ GRNDWRK_NO_UPDATE_CHECK: '0' }, root)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('says so only for a later version', () => {
    expect(isNewer('0.4.10', '0.4.9')).toBe(true)
    expect(isNewer('0.4.3', '0.4.3')).toBe(false)
    expect(isNewer('0.4.2', '0.4.3')).toBe(false)
    expect(npmNotice('0.5.0', '0.4.3')).toMatch(/grndwrk 0\.5\.0 is out \(this is 0\.4\.3\)\. Update with npm install -g grndwrk, then run grndwrk init/)
    expect(npmNotice('0.4.3', '0.4.3')).toBeNull()
    expect(npmNotice(null, '0.4.3')).toBeNull()
  })
})
