import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clashesWith, freePort, keepPort, readPorts } from '../src/store/ports.js'

let dir: string
let file: string
const project = async (name: string) => {
  const gw = join(dir, name, '.grndwrk')
  await mkdir(gw, { recursive: true })
  return gw
}
const nothingAnswers = async () => false

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-ports-'))
  file = join(dir, 'state', 'ports.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('ports kept by projects on this machine', () => {
  it('gives a new project ports no other project keeps, even one that is not running', async () => {
    const a = await project('a')
    const b = await project('b')
    const c = await project('c')
    await keepPort(a, 7777, file)
    await keepPort(b, 7781, file)
    const all = await readPorts(file)
    // 7777 to 7779 are a's, 7781 to 7783 b's: 7780 would overlap b, so 7784.
    expect(await freePort(all, c, nothingAnswers)).toBe(7784)
    expect(clashesWith(all, c, 7778)).toEqual(['a'])
    expect(clashesWith(all, c, 7784)).toEqual([])
    // A project never clashes with itself.
    expect(clashesWith(all, a, 7777)).toEqual([])
  })

  it('skips ports something on this Mac answers on now', async () => {
    const c = await project('c')
    expect(await freePort({}, c, async (p) => p === 7778)).toBe(7779)
  })

  it('gives back the ports of a project whose folder is gone, and keeps the file private', async () => {
    const a = await project('a')
    const gone = await project('gone')
    await keepPort(a, 7777, file)
    await keepPort(gone, 7780, file)
    await rm(join(dir, 'gone'), { recursive: true })
    expect(await readPorts(file)).toEqual({ [a]: 7777 })
    const { stat } = await import('node:fs/promises')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('reads a broken or odd file as keeping nothing', async () => {
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(file, '{ not json')
    expect(await readPorts(file)).toEqual({})
    const a = await project('a')
    await writeFile(file, JSON.stringify({ [a]: 'x', '/nowhere/.grndwrk': 7777, [join(dir, 'a', '.grndwrk')]: 70000 }))
    expect(await readPorts(file)).toEqual({})
    await keepPort(a, 7790, file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [a]: 7790 })
  })
})
