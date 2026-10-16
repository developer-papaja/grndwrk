import { parse } from 'yaml'

/**
 * Frontmatter: the YAML between a `---` on the first line and the next `---`
 * line, and the text after it. Split the way gray-matter did, which these
 * files were written for, and parsed with `yaml` as plain data. The word
 * after the opening `---` may only say YAML: gray-matter ran `---js` blocks
 * as code, and a file that asks for anything else is refused, so it shows as
 * unreadable instead.
 */
export interface Matter {
  data: Record<string, unknown>
  content: string
}

export function readMatter(raw: string): Matter {
  // Git on Windows often checks files out with CRLF line ends, and some
  // editors there start a file with a byte order mark. The YAML parser would
  // keep the \r in values (`start: new\r`) or refuse `[a, b]\r`; read both as plain lines.
  raw = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!raw.startsWith('---') || raw.charAt(3) === '-') return { data: {}, content: raw }
  let rest = raw.slice(3)
  const language = /^[^\n]*/.exec(rest)?.[0] ?? ''
  if (language.trim() && !/^\s*ya?ml\s*$/i.test(language)) {
    throw new Error(`The frontmatter says it is ${language.trim()}. grndwrk only reads YAML: start the file with a plain ---`)
  }
  rest = rest.slice(language.length)
  const close = rest.indexOf('\n---')
  const block = close === -1 ? rest : rest.slice(0, close)
  let content = close === -1 ? '' : rest.slice(close + 4)
  if (content.startsWith('\n')) content = content.slice(1)
  // Only comments and blank lines: no fields.
  if (!block.replace(/^\s*#[^\n]+/gm, '').trim()) return { data: {}, content }
  // YAML 1.2, no custom tags: dates stay text, nothing becomes code.
  const read = (text: string): unknown => parse(text, { prettyErrors: false, logLevel: 'error' })
  let data: unknown
  try {
    data = read(block)
  } catch (err) {
    // The most common slip, by people and by Claude alike: a sentence with a
    // colon in it, unquoted (`purpose: Explain our work: why and how`). Read
    // it as the sentence it is meant to be; the file itself is left as it is.
    const quoted = quoteSentences(block)
    if (quoted === block) throw err
    try {
      data = read(quoted)
    } catch {
      throw err
    }
  }
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, content }
}

/** Plain values and list items holding ": " put in double quotes, so they read as one text. */
function quoteSentences(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      const m = /^(\s*[A-Za-z_][\w.-]*:[ \t]+|\s*-[ \t]+)(.*?)\s*$/.exec(line)
      if (!m) return line
      const value = m[2]
      // Already quoted, a list or mapping in brackets, a block, an anchor or a tag: not a plain sentence.
      if (!value.includes(': ') || /^["'[{|>&*!%@`]/.test(value)) return line
      return `${m[1]}${JSON.stringify(value)}`
    })
    .join('\n')
}
