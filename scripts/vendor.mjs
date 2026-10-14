// Copies the libraries the Comment button loads in the product's page into
// dist/vendor, with their licenses, so the published package carries them
// without needing them installed.
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'vendor')
await mkdir(out, { recursive: true })
const from = join(root, 'node_modules', 'modern-screenshot')
await copyFile(join(from, 'dist', 'index.js'), join(out, 'modern-screenshot.js'))
await copyFile(join(from, 'LICENSE'), join(out, 'modern-screenshot.LICENSE'))
