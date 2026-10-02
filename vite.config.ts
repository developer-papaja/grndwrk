import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
    // three.js is large, and this is only ever served from localhost.
    chunkSizeWarningLimit: 2000,
  },
})
