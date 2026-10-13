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
  if (!raw.startsWith('---') || raw.charAt(3) === '-') return { data: {}, content: raw }
  let rest = raw.slice(3)
  const language = /^[^\n]*/.exec(rest)?.[0] ?? ''
  if (language.trim() && !/^\s*ya?ml\s*$/i.test(language)) {
    throw new Error(`The frontmatter says it is ${language.trim()}. Groundwork only reads YAML: start the file with a plain ---`)
  }
  rest = rest.slice(language.length)
  const close = rest.indexOf('\n---')
  const block = close === -1 ? rest : rest.slice(0, close)
  let content = close === -1 ? '' : rest.slice(close + 4)
  if (content.startsWith('\r')) content = content.slice(1)
  if (content.startsWith('\n')) content = content.slice(1)
  // Only comments and blank lines: no fields.
  if (!block.replace(/^\s*#[^\n]+/gm, '').trim()) return { data: {}, content }
  // YAML 1.2, no custom tags: dates stay text, nothing becomes code.
  const data: unknown = parse(block, { prettyErrors: false, logLevel: 'error' })
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, content }
}
