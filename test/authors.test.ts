import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstAuthors } from '../src/server/authors.js'

describe('firstAuthors', () => {
  it('names whoever committed each node file first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gw-authors-'))
    const gw = join(root, '.grndwrk')
    await mkdir(join(gw, 'nodes'), { recursive: true })
    const g = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    g('init', '-q')
    const commit = async (who: string, file: string, text: string) => {
      await writeFile(join(gw, 'nodes', file), text)
      g('add', '.')
      g('-c', `user.name=${who}`, '-c', 'user.email=x@example.com', 'commit', '-qm', 'x')
    }
    await commit('Måns Brengesjö', 'n_aaaaaa.md', 'one')
    await commit('Sam', 'n_bbbbbb.md', 'two')
    await commit('Sam', 'n_aaaaaa.md', 'one, changed')
    expect(await firstAuthors(gw)).toEqual({ n_aaaaaa: 'Måns Brengesjö', n_bbbbbb: 'Sam' })
  })
})
