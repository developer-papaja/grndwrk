// Copies the libraries the Comment button loads in the product's page into
// dist/vendor, with their licenses, so the published package carries them
// without needing them installed. Each file must be exactly the one reviewed:
// a changed node_modules fails the build instead of shipping something else.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// modern-screenshot 4.7.0, dist/index.js. Update together with the version in package.json, after reading the new one.
const SHA256 = 'bb36665889124a0b6e15f16045265737449c3bdcf2712cdb08af3cfa01563e2b'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'vendor')
await mkdir(out, { recursive: true })
const from = join(root, 'node_modules', 'modern-screenshot')
const lib = join(from, 'dist', 'index.js')
const found = createHash('sha256').update(await readFile(lib)).digest('hex')
if (found !== SHA256) {
  console.error(`modern-screenshot is not the reviewed copy (sha256 ${found}, expected ${SHA256}).`)
  process.exit(1)
}
await copyFile(lib, join(out, 'modern-screenshot.js'))
await copyFile(join(from, 'LICENSE'), join(out, 'modern-screenshot.LICENSE'))
