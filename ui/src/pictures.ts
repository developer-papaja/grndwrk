/**
 * Which pictures the map may show from its own server, as one exact path.
 *
 * A picture in a card's notes is `../files/<id>/<name>`; in a thread entry's
 * own file it is `../../files/<id>/<name>`. Both name exactly one picture of
 * one card, screen or persona: `files/<id>/<name>`. Anything else (another
 * folder, `..` or `.` inside, an encoded character, a backslash, a query) is
 * no picture, so rendering a file never makes the browser ask its own server
 * for some other path with its cookies. On a Mac, pictures of screens
 * (`/shots/web/<name>`, `/shots/ios/<name>`) are pictures too; the page on a
 * store has none.
 */

const PREFIX = /^(?:\.\.\/\.\.\/|\.\.\/|\/)?files\//
const OWNER = /^(?:n|p|pe|sg)_[A-Za-z0-9_]{1,60}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}(?:\.[A-Za-z0-9_-]{1,40}){0,3}\.(?:png|jpe?g|gif|webp)$/i
const SHOT = /^\/?(?:\.grndwrk\/)?shots\/(web|ios|android)\/([^/\\]{1,200})$/

/** The picture `src` names, as `files/<id>/<name>` (or `shots/<platform>/<name>` with `shots`), or null when it names none. */
export function picturePath(src: string, opts: { shots?: boolean } = {}): string | null {
  if (typeof src !== 'string' || src.length > 400) return null
  // No whitespace, control characters, backslashes, queries or fragments: an exact path or nothing.
  if (/[\s\p{Cc}\p{Cf}\\?#]/u.test(src)) return null
  const prefix = PREFIX.exec(src)
  if (prefix) {
    // Names of pictures in the map never hold a percent sign: an encoded character is no picture.
    const [owner, name, ...more] = src.slice(prefix[0].length).split('/')
    if (more.length || !OWNER.test(owner ?? '') || !NAME.test(name ?? '')) return null
    return `files/${owner}/${name}`
  }
  if (!opts.shots) return null
  const shot = SHOT.exec(src)
  if (!shot) return null
  // A picture of a screen is named after the screen, encoded: one name, never a way out of its folder.
  let name: string
  try {
    name = decodeURIComponent(shot[2])
  } catch {
    return null
  }
  if (name.startsWith('.') || /[/\\\p{Cc}\p{Cf}]/u.test(name) || !/\.(?:png|jpe?g)$/i.test(name)) return null
  return `shots/${shot[1]}/${shot[2]}`
}
