import { mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
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
    // Windows device names: CON.png would open the console there.
    for (const name of ['CON.png', 'nul.jpg', 'com1.png', 'LPT9.webp']) expect(await readImage(root, 'n_abcd', name)).toBeNull()
  })

  it('removes a node folder', async () => {
    await saveImage(root, 'n_abcd', 'image/gif', Buffer.from('gif'))
    await removeFiles(root, 'n_abcd')
    expect(await readdir(join(root, 'files'))).toEqual([])
  })

  it('serves a picture a project tool named, but no name with a dot or a slash in it', async () => {
    await mkdir(join(root, 'files', 'n_abcd'), { recursive: true })
    await writeFile(join(root, 'files', 'n_abcd', 'uitest-1794934456928-step1-0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect((await readImage(root, 'n_abcd', 'uitest-1794934456928-step1-0.png'))?.type).toBe('image/png')
    expect(await readImage(root, 'n_abcd', 'a.b.png')).toBeNull()
    expect(await readImage(root, 'n_abcd', '-x.png')).toBeNull()
    expect(await readImage(root, 'n_abcd', '..png')).toBeNull()
  })
})
