import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The parser Alpine's CSP build runs instead of eval: an expression it cannot read fails in the map.
// @ts-expect-error: plain JavaScript without types
import { Parser, Tokenizer } from '@alpinejs/csp/src/parser.js'

const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Every Alpine expression in the map's page, with its line. */
function expressions(): { name: string; value: string; line: number }[] {
  const out: { name: string; value: string; line: number }[] = []
  for (const m of html.matchAll(/\s((?:x-|@|:)[\w.:-]+)="([^"]*)"/g)) {
    const name = m[1]
    // Not expressions: names, CSS classes for transitions, a place to teleport to.
    if (/^x-(cloak|ref|ignore|teleport)$/.test(name) || name.startsWith('x-transition')) continue
    let value = decode(m[2])
    if (name === 'x-for') value = value.replace(/^\s*\(?[^)]*?\)?\s+(in|of)\s+/, '')
    if (!value.trim()) continue
    out.push({ name, value, line: html.slice(0, m.index).split('\n').length })
  }
  return out
}

describe("the map's page under a Content-Security-Policy without eval", () => {
  it('finds the expressions it checks', () => {
    expect(expressions().length).toBeGreaterThan(2000)
  })

  it('has only expressions the CSP build of Alpine can read', () => {
    const bad = expressions().flatMap((e) => {
      try {
        new Parser(new Tokenizer(e.value).tokenize()).parse()
        return []
      } catch (err) {
        return [`${e.line} ${e.name}="${e.value.slice(0, 120)}": ${(err as Error).message}`]
      }
    })
    expect(bad).toEqual([])
  })

  it('sets no property of an element from an expression: the CSP build refuses that while it runs', () => {
    const bad = expressions().filter((e) => /(\$event\.(?:target|currentTarget|dataTransfer)|\$el|\$refs\.\w+)(\.\w+)+\s*=[^=]/.test(e.value))
    expect(bad.map((e) => `${e.line} ${e.name}="${e.value}"`)).toEqual([])
  })

  it('uses x-markup, never x-html, which the CSP build refuses', () => {
    expect(html).not.toMatch(/\sx-html=/)
  })

  it('allows no eval in any Content-Security-Policy the page is served with', () => {
    for (const file of ['../ui/index.html', '../src/shared-store/page.ts', '../stores/cloudflare/src/page.ts', '../stores/firebase/functions.mjs', '../stores/php/src/Api.php']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toContain('unsafe-eval')
    }
  })

  it('reaches no globals from an expression: the CSP build refuses them while it runs', () => {
    const globals = /(?<![.$\w])(Math|String|Number|Object|Array|JSON|Date|Boolean|Set|Map|Promise|window|document|location|navigator|console|setTimeout|clearTimeout|encodeURIComponent|decodeURIComponent|Intl|parseInt|parseFloat|isNaN|localStorage|sessionStorage|history|URL|requestAnimationFrame|getComputedStyle|alert|confirm|prompt|fitCapture)\b/
    const bad = expressions().flatMap((e) => {
      const m = globals.exec(e.value.replace(/'(?:[^'\\]|\\.)*'/g, "''"))
      return m ? [`${e.line} ${e.name}: ${m[1]} in "${e.value.slice(0, 100)}"`] : []
    })
    expect(bad).toEqual([])
  })
})
