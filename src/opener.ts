import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

/**
 * Open a web address in the default browser, or a file in the app the system
 * opens it with. The system's own opener is started directly, with the target
 * as its one argument and no shell, so nothing in it is ever read as a
 * command. Only an http(s) address or an absolute path is opened: anything
 * else (a target starting with "-" could pass for an option) is refused.
 */
export function openTarget(target: string): Promise<void> {
  if (!/^https?:\/\//i.test(target) && !isAbsolute(target)) return Promise.reject(new Error(`Not an address or a full path: ${target}`))
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? // Keeps the #part of an address, which `start` and explorer drop.
          ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
        : ['xdg-open', [target]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
