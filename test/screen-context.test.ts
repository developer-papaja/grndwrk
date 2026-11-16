import { describe, expect, it } from 'vitest'
import { screenContext, screenForName, screenForPath } from '../src/shared/screen-context.js'
import type { Persona, Screen } from '../src/shared/types.js'

const screen = (id: string, title: string, extra: Partial<Screen> = {}): Screen => ({
  id, title, parent: '', purpose: '', audience: [], tasks: [], leads_to: [], code: [], open: [], seen_as: [], shots: [], in: [], replaced_by: '', part: '', stories: [], features: [], status: 'built', hidden: '', source: '', created: '', body: '', ...extra,
})

const persona = (name: string, summary: string, jobs: string): Persona =>
  ({ id: 'pe_' + name.slice(0, 6).toLowerCase(), name, summary, jobs, first: '', judged_on: '', goes_wrong: '', implications: '', evidence: '' }) as unknown as Persona

const screens = [
  screen('p_home', 'Start', { code: ['/'] }),
  screen('p_visits', 'Visits', { code: ['/visits', 'app/Http/VisitController.php'] }),
  screen('p_visit', 'Visit', { code: ['/visits/{visit}'], purpose: 'See one visit and what was done.', audience: ['Clinic coordinator', 'Vet'] }),
  screen('p_new', 'New visit', { code: ['/visits/new'] }),
  screen('p_play', 'Playground', { code: ['/play'], hidden: '2026-11-01' }),
]

describe('screenForPath', () => {
  it('finds a screen by its route, with or without a trailing slash', () => {
    expect(screenForPath('/', screens)?.id).toBe('p_home')
    expect(screenForPath('/visits/', screens)?.id).toBe('p_visits')
  })

  it('matches parameters, the most specific route first', () => {
    expect(screenForPath('/visits/42', screens)?.id).toBe('p_visit')
    expect(screenForPath('/visits/new', screens)?.id).toBe('p_new')
    expect(screenForPath('/visits/42/edit', screens)).toBeNull()
  })

  it('reads :id, [id] and catch-all routes too', () => {
    const more = [screen('a', 'A', { code: ['/pets/:pet'] }), screen('b', 'B', { code: ['/docs/[...slug]'] })]
    expect(screenForPath('/pets/7', more)?.id).toBe('a')
    expect(screenForPath('/docs/a/b', more)?.id).toBe('b')
  })

  it('never answers with a hidden screen', () => {
    expect(screenForPath('/play', screens)).toBeNull()
  })
})

describe('screenContext', () => {
  it('gives the purpose and each persona with summary and jobs', () => {
    const personas = [persona('Clinic coordinator', 'Runs the clinic day.', '1. Move appointments when a vet is ill.\n2. Answer owners who call.')]
    expect(screenContext('/visits/42', screens, personas)).toEqual({
      id: 'p_visit',
      title: 'Visit',
      purpose: 'See one visit and what was done.',
      personas: [
        { name: 'Clinic coordinator', summary: 'Runs the clinic day.', jobs: ['Move appointments when a vet is ill.', 'Answer owners who call.'] },
        // A name that is no persona yet still shows, without more.
        { name: 'Vet', summary: '', jobs: [] },
      ],
    })
  })
})

describe('screenForName', () => {
  const app = [
    screen('p_list', 'Visits', { code: ['App/Visits/VisitListView.swift'] }),
    screen('p_one', 'Visit', { code: ['App/Visits/VisitView.swift'], seen_as: ['Visit details'] }),
  ]
  it('finds the screen by the view the phone reads, before a shared name', () => {
    expect(screenForName('App', 'VisitView', app)?.id).toBe('p_one')
  })
  it('finds it by its title or the name the app shows', () => {
    expect(screenForName('visits', '', app)?.id).toBe('p_list')
    expect(screenForName('Visit details', '', app)?.id).toBe('p_one')
    expect(screenForName('Settings', '', app)).toBeNull()
  })
})
