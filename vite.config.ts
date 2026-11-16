import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * `vite build --mode page`: the map as the page a team's store serves
 * (dist/page). The UI talks to the store itself (ui/src/api-store.ts, in
 * api.ts's place), and runs grndwrk's own store code (src/store/*) over the
 * map kept in memory: their file calls go to ui/src/page/vfs.ts, and the few
 * Node modules they use to small stand-ins in ui/src/page/.
 */
function page(): Plugin {
  const swap: Record<string, string> = {
    'node:path': at('./ui/src/page/path.ts'),
    'node:crypto': at('./ui/src/page/crypto.ts'),
    'node:fs/promises': at('./ui/src/page/vfs.ts'),
  }
  return {
    name: 'grndwrk-page',
    enforce: 'pre',
    resolveId(source, importer) {
      if (swap[source]) return swap[source]
      if (!importer) return null
      const from = importer.replace(/\\/g, '/')
      if (source === './api' && from.includes('/ui/src/')) return at('./ui/src/api-store.ts')
      if (from.includes('/src/store/') && source === './fs.js') return at('./ui/src/page/vfs.ts')
      if (from.includes('/src/store/') && source === '../root.js') return at('./ui/src/page/root.ts')
      return null
    },
  }
}

export default defineConfig(({ mode }) => ({
  root: at('./ui'),
  // The page is served under each project's address (<store>/<project>/), so its files are found next to it.
  base: mode === 'page' ? './' : '/',
  plugins: [tailwindcss(), ...(mode === 'page' ? [page()] : [])],
  define: mode === 'page' ? { 'process.pid': '0', 'process.env.GRNDWRK_WAITING_FILE': 'undefined' } : {},
  build: {
    outDir: at(mode === 'page' ? './dist/page' : './dist/ui'),
    emptyOutDir: true,
  },
}))
