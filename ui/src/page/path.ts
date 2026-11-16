/** `node:path` for the store code in the page: POSIX paths in the in-memory map (vfs.ts). */
export const sep = '/'

function normalize(path: string): string {
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (!p || p === '.') continue
    if (p === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop()
    else if (p !== '..' || !abs) parts.push(p)
  }
  return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.')
}

export const join = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'))
export const resolve = (...parts: string[]) => normalize(`/${parts.join('/')}`)
export function dirname(path: string): string {
  const p = normalize(path)
  const at = p.lastIndexOf('/')
  return at <= 0 ? (p.startsWith('/') ? '/' : '.') : p.slice(0, at)
}
export function basename(path: string, ext?: string): string {
  const b = normalize(path).split('/').pop() ?? ''
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b
}
export const extname = (path: string) => /\.[^./]*$/.exec(basename(path))?.[0] ?? ''

export default { sep, join, resolve, dirname, basename, extname }
