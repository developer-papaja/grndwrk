import { describe, expect, it } from 'vitest'
import { parseAreas } from '../src/shared/report.js'

describe('parseAreas', () => {
  it('reads the areas the way /readiness writes them', () => {
    const body = `Still ready to prototype.

## Areas

**Purpose: enough.** n_rlee says who it is for.

**Core flows: thin.** The kickoff flow is still not written.
It spans two lines.

**Technical: missing in the map.** Decided in CLAUDE.md.

## The smallest set of things to add

1. Write the kickoff flow.
`
    expect(parseAreas(body)).toEqual([
      { name: 'Purpose', status: 'enough', text: 'n_rlee says who it is for.' },
      { name: 'Core flows', status: 'thin', text: 'The kickoff flow is still not written. It spans two lines.' },
      { name: 'Technical', status: 'missing', text: '(in the map) Decided in CLAUDE.md.' },
    ])
  })

  it('returns nothing for text without areas', () => {
    expect(parseAreas('Just a paragraph.\n\n**Bold** but not an area.')).toEqual([])
  })
})
