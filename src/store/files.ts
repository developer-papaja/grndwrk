import { mkdir, readFile, rm, writeFile } from './fs.js'
import { join } from 'node:path'
import { isValidId } from './frontmatter.js'

/** Images a node can hold, by content type. */
export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// What the map names an upload (`1794934456930.png`), or a name a project's own tool chose (`uitest-step1.png`):
// letters, digits, - and _ only, so never a dot or a slash that could climb out of the card's folder.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(png|jpg|gif|webp)$/
// Windows device names (CON.png opens the console there) are never picture names.
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)\./i

export function filesDir(gwDir: string, nodeId: string): string {
  if (!isValidId(nodeId)) throw new Error(`Invalid id: ${nodeId}`)
  return join(gwDir, 'files', nodeId)
}

/**
 * Save an image for a node and return the markdown that shows it. The path is
 * relative to the node file, so it also renders on GitHub.
 */
export async function saveImage(gwDir: string, nodeId: string, type: string, data: Buffer): Promise<{ markdown: string; url: string }> {
  const ext = IMAGE_TYPES[type]
  if (!ext) throw new Error('Only png, jpeg, gif and webp images')
  if (data.length > MAX_IMAGE_BYTES) throw new Error('Images can be at most 10 MB')
  const dir = filesDir(gwDir, nodeId)
  await mkdir(dir, { recursive: true })
  let name = `${Date.now()}.${ext}`
  for (let i = 1; await exists(join(dir, name)); i++) name = `${Date.now()}-${i}.${ext}`
  await writeFile(join(dir, name), data)
  return { markdown: `![](../files/${nodeId}/${name})`, url: `/files/${nodeId}/${name}` }
}

/** Read a saved image. Only names this module could have written are accepted. */
export async function readImage(gwDir: string, nodeId: string, name: string): Promise<{ data: Buffer; type: string } | null> {
  if (!isValidId(nodeId) || !NAME.test(name) || DEVICE.test(name)) return null
  try {
    const data = await readFile(join(filesDir(gwDir, nodeId), name))
    const ext = name.split('.').pop()!
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)![0]
    return { data, type }
  } catch {
    return null
  }
}

export async function removeFiles(gwDir: string, nodeId: string): Promise<void> {
  await rm(filesDir(gwDir, nodeId), { recursive: true, force: true })
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
