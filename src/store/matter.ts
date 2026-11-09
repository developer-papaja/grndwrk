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
  /** What had to be read leniently because the header is not valid YAML as written; `grndwrk check` lists it. */
  repaired?: string[]
}

/** A header that does not parse, with where in the file it breaks (lines counted from the file's first line). */
export class MatterError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(line ? `Line ${line}, column ${column}: ${message}` : message)
  }
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
  const read = (text: string): unknown => parse(text, { prettyErrors: true, logLevel: 'error' })
  let data: unknown
  let repaired: string[] | undefined
  try {
    data = read(block)
  } catch (err) {
    // The common slips, by people and by Claude alike: a sentence with a colon
    // in it, unquoted (`purpose: Explain our work: why and how`), and a list
    // in brackets whose items hold { } [ ] or start with # (`applies_to:
    // [/visits/{visit}]`, a route with a parameter). Read them as meant; the
    // file itself is left as it is, and `grndwrk check` says what to fix.
    const fixes: string[] = []
    const quoted = quoteFlowItems(quoteSentences(block, fixes), fixes)
    if (quoted === block) throw matterError(err)
    try {
      data = read(quoted)
      repaired = fixes
    } catch {
      throw matterError(err)
    }
  }
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, content, ...(repaired ? { repaired } : {}) }
}

/** The parser's message as one line, with the line and column in the file (the block starts on the `---` line). */
function matterError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err))
  const pos = (err as { linePos?: [{ line: number; col: number }] }).linePos?.[0]
  const message = err.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
  return pos ? new MatterError(message, pos.line, pos.col) : new MatterError(message)
}

/** Items of a one-line `key: [a, b]` list put in double quotes when one would not read as plain text. */
function quoteFlowItems(block: string, fixes: string[]): string {
  return block
    .split('\n')
    .map((line) => {
      const m = /^(\s*[A-Za-z_][\w.-]*:[ \t]+)\[(.*)\]\s*$/.exec(line)
      if (!m || !/[{}[\]#&*!|>%@`]/.test(m[2])) return line
      const items = m[2].split(',').map((x) => x.trim())
      if (items.some((x) => !x)) return line
      const quote = (x: string) => (/^(".*"|'.*')$/.test(x) ? x : JSON.stringify(x))
      fixes.push(`${m[1].trim().slice(0, -1)}: quote each item in the list ([${items.map(quote).join(', ')}])`)
      return `${m[1]}[${items.map(quote).join(', ')}]`
    })
    .join('\n')
}

/** Plain values and list items holding ": " put in double quotes, so they read as one text. */
function quoteSentences(block: string, fixes: string[]): string {
  return block
    .split('\n')
    .map((line) => {
      const m = /^(\s*[A-Za-z_][\w.-]*:[ \t]+|\s*-[ \t]+)(.*?)\s*$/.exec(line)
      if (!m) return line
      const value = m[2]
      // Already quoted, a list or mapping in brackets, a block, an anchor or a tag: not a plain sentence.
      if (!value.includes(': ') || /^["'[{|>&*!%@`]/.test(value)) return line
      fixes.push(`${m[1].trim().replace(/:$/, '') || '-'}: put the value in double quotes, it holds ": "`)
      return `${m[1]}${JSON.stringify(value)}`
    })
    .join('\n')
}
