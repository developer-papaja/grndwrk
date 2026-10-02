import { watch } from 'chokidar'
import { basename, relative, sep } from 'node:path'
import { broadcast, type NodeSync } from './events.js'

/** Watch `.groundwork/` and push changes made by Claude Code or by hand. */
export function watchGroundwork(gwDir: string, nodes: NodeSync) {
  let timer: NodeJS.Timeout | undefined
  let running = Promise.resolve()
  const scheduleSync = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running.then(() => nodes.sync()).catch((err) => console.error('sync failed:', err))
    }, 40)
  }

  const watcher = watch(gwDir, {
    ignoreInitial: true,
    // Skip dotfiles, which includes our own temp files.
    ignored: (path) => path !== gwDir && basename(path).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  })

  watcher.on('all', (event, path) => {
    if (event === 'addDir' || event === 'unlinkDir') return
    const rel = relative(gwDir, path).split(sep).join('/')
    if (rel.startsWith('nodes/') && rel.endsWith('.md')) scheduleSync()
    else broadcast({ type: 'file:change', path: rel })
  })

  return watcher
}
