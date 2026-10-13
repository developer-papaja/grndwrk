import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMatter } from '../src/store/matter.js'
import { describe, expect, it } from 'vitest'
import { listScreens, parseScreen, serializeScreen } from '../src/store/screens.js'
import { counterpart, inVariant, onlyIn, projectVariants, unknownVariants, variantView } from '../src/shared/variants.js'

const GW = join(import.meta.dirname, 'fixtures', 'variants', '.groundwork')

describe('variants', () => {
  it('reads the variants from project.md, the first being the default', async () => {
    const { data } = readMatter(await readFile(join(GW, 'project.md'), 'utf8'))
    expect(projectVariants(data)).toEqual(['New UI', 'Previous UI'])
    expect(projectVariants({})).toEqual([])
  })

  it('shows each variant its own tree: shared screens and its own', async () => {
    const screens = (await listScreens(GW)).filter((s) => !s.error)
    const ids = (v: string | null) => variantView(screens, v).map((s) => s.id).sort()
    expect(ids('New UI')).toEqual(['p_book', 'p_help', 'p_home', 'p_ins', 'p_plan', 'p_set'])
    expect(ids('Previous UI')).toEqual(['p_book', 'p_help', 'p_home', 'p_list', 'p_more', 'p_set'])
    expect(ids(null)).toHaveLength(screens.length)
    // Matched regardless of case.
    expect(inVariant(screens.find((s) => s.id === 'p_plan')!, 'new ui')).toBe(true)
  })

  it('moves a screen up to the nearest parent in the variant, and drops links out of it', async () => {
    const screens = (await listScreens(GW)).filter((s) => !s.error)
    const inNew = variantView(screens, 'New UI')
    // Help sits under More, which only the previous UI has.
    expect(inNew.find((s) => s.id === 'p_help')!.parent).toBe('p_home')
    expect(inNew.find((s) => s.id === 'p_book')!.leads_to).toEqual(['p_plan'])
    const inOld = variantView(screens, 'Previous UI')
    expect(inOld.find((s) => s.id === 'p_help')!.parent).toBe('p_more')
    expect(inOld.find((s) => s.id === 'p_book')!.leads_to).toEqual(['p_list'])
  })

  it('pairs a screen with the one that replaces it, both ways', async () => {
    const screens = await listScreens(GW)
    const by = (id: string) => screens.find((s) => s.id === id)!
    expect(counterpart(by('p_list'), screens)?.id).toBe('p_plan')
    expect(counterpart(by('p_plan'), screens)?.id).toBe('p_list')
    expect(counterpart(by('p_book'), screens)).toBeNull()
  })

  it('says what retiring a variant removes', async () => {
    const screens = await listScreens(GW)
    expect(onlyIn(screens, 'Previous UI').map((s) => s.id).sort()).toEqual(['p_list', 'p_more'])
  })

  it('points out a variant project.md does not list', () => {
    const s = parseScreen('p_x', '---\nid: p_x\ntitle: X\nin: [Old UI]\n---\n')
    expect(unknownVariants(s, ['New UI', 'Previous UI'])).toEqual(['Old UI'])
  })

  it('writes in and replaced_by back on one line each, and leaves them out when empty', () => {
    const s = parseScreen('p_list', '---\nid: p_list\ntitle: Desk list\nin: [Previous UI]\nreplaced_by: p_plan\n---\nNotes\n')
    const out = serializeScreen(s, {}, s.body)
    expect(out).toContain('in: [Previous UI]\nreplaced_by: p_plan\n')
    expect(serializeScreen(parseScreen('p_a', '---\nid: p_a\ntitle: A\n---\n'), {}, '')).not.toMatch(/^in:|^replaced_by:/m)
  })
})

describe('screen files that cannot be read', () => {
  it('say why instead of showing as an empty box', async () => {
    const bad = (await listScreens(GW)).find((s) => s.id === 'p_bad')!
    expect(bad.error).toMatch(/not valid YAML/)
    expect(bad.error).toMatch(/colon in it needs quotes/)
    expect(parseScreen('p_a', '').error).toBe('The file is empty.')
    expect(parseScreen('p_a', '\n---\ntitle: A\n---\n').error).toMatch(/first line/)
    expect(parseScreen('p_a', 'title: A\n').error).toMatch(/No frontmatter/)
    expect(parseScreen('p_a', '---\ntitle: A\n---\n').error).toBeUndefined()
  })
})
