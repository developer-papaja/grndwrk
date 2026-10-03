/** The page a node is on. A node without one is on the first page. */
export function pageOf(node: { page: string }, pages: string[]): string {
  return node.page || pages[0]
}

export function samePage(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The pages to show: the saved order first, then any page that nodes use but
 * the list does not have yet, so a hand edit never hides nodes. Never empty.
 */
export function mergePages(saved: string[], used: string[]): string[] {
  const out = [...saved]
  for (const p of used) if (p && !out.some((o) => samePage(o, p))) out.push(p)
  return out.length ? out : ['Main']
}
