import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readImage, removeFiles, saveImage } from '../src/store/files.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gw-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('images', () => {
  it('saves an image next to the node and links it relative to the node file', async () => {
    const out = await saveImage(root, 'n_abcd', 'image/png', Buffer.from('png'))
    expect(out.markdown).toMatch(/^!\[\]\(\.\.\/files\/n_abcd\/\d+\.png\)$/)
    const name = out.url.split('/').pop()!
    expect((await readImage(root, 'n_abcd', name))?.type).toBe('image/png')
  })

  it('refuses other types, big files and odd paths', async () => {
    await expect(saveImage(root, 'n_abcd', 'text/html', Buffer.from('x'))).rejects.toThrow()
    await expect(saveImage(root, 'n_abcd', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow()
    await expect(saveImage(root, '../x', 'image/png', Buffer.from('x'))).rejects.toThrow()
    expect(await readImage(root, 'n_abcd', '../../project.md')).toBeNull()
    expect(await readImage(root, '..', '1234567890123.png')).toBeNull()
  })

  it('removes a node folder', async () => {
    await saveImage(root, 'n_abcd', 'image/gif', Buffer.from('gif'))
    await removeFiles(root, 'n_abcd')
    expect(await readdir(join(root, 'files'))).toEqual([])
  })
})
