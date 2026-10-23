import type { Screen } from './types.js'

/**
 * A product can exist in several variants at once, like a redesign behind a
 * "Use beta" switch next to the previous UI. Variants are listed in
 * project.md (`variants: [New UI, Previous UI]`, the first is the default).
 * A screen without `in:` is in every variant; `in: [Previous UI]` puts it in
 * that one only. No variants: everything works as without them.
 */

/** The variants project.md lists, in order. Empty when there are none. */
export function projectVariants(project: Record<string, unknown>): string[] {
  const v = project.variants
  const list = Array.isArray(v) ? v.map((x) => String(x).trim()) : typeof v === 'string' ? v.split(',').map((x) => x.trim()) : []
  return [...new Set(list.filter(Boolean))]
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Whether a screen is part of a variant. Null means all variants: every screen. */
export function inVariant(screen: Screen, variant: string | null): boolean {
  return variant === null || !screen.in.length || screen.in.some((v) => same(v, variant))
}

/** Variants a screen names that project.md does not list, to point out as a likely typo. */
export function unknownVariants(screen: Screen, variants: string[]): string[] {
  return screen.in.filter((v) => !variants.some((known) => same(known, v)))
}

/**
 * The screens of one variant, as that variant's own site map: shared screens
 * and the variant's own. A parent outside the variant gives way to the
 * nearest ancestor inside it (or the top), and links to screens outside it
 * are left out, so nothing is drawn as broken. Null: every screen, untouched.
 */
export function variantView(screens: Screen[], variant: string | null): Screen[] {
  if (variant === null) return screens
  return narrowView(screens, new Set(screens.filter((s) => inVariant(s, variant)).map((s) => s.id)))
}

/**
 * Only the screens in `shown`, as a site map of their own: a parent left out
 * gives way to the nearest ancestor shown (or the top), and links to screens
 * left out are dropped.
 */
export function narrowView(screens: Screen[], shown: Set<string>): Screen[] {
  const byId = new Map(screens.map((s) => [s.id, s]))
  const parentIn = (s: Screen): string => {
    const seen = new Set<string>()
    let p = s.parent
    while (p && !shown.has(p) && !seen.has(p)) {
      seen.add(p)
      p = byId.get(p)?.parent ?? ''
    }
    return p && shown.has(p) ? p : ''
  }
  return screens
    .filter((s) => shown.has(s.id))
    .map((s) => ({ ...s, parent: parentIn(s), leads_to: s.leads_to.filter((id) => shown.has(id)) }))
}

/**
 * The screen that stands for this one in another variant: the one it names
 * in `replaced_by`, or one that names it.
 */
export function counterpart(screen: Screen, screens: Screen[]): Screen | null {
  if (screen.replaced_by) {
    const target = screens.find((s) => s.id === screen.replaced_by)
    if (target) return target
  }
  return screens.find((s) => s.replaced_by === screen.id && s.id !== screen.id) ?? null
}

/** What retiring a variant would remove: the screens only it has. */
export function onlyIn(screens: Screen[], variant: string): Screen[] {
  return screens.filter((s) => s.in.length > 0 && s.in.every((v) => same(v, variant)))
}
