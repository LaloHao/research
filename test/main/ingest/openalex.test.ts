import { describe, expect, it } from 'vitest'
import { authorFromDisplayName, bareOpenAlexId, normalizeTitle } from '../../../src/main/ingest/openalex'

describe('OpenAlex helpers', () => {
  it('strips the URL prefix of work ids', () => {
    expect(bareOpenAlexId('https://openalex.org/W2754665629')).toBe('W2754665629')
    expect(bareOpenAlexId('https://api.openalex.org/works/W1')).toBe('W1')
    expect(bareOpenAlexId('W7')).toBe('W7')
  })

  it('splits display names into given and family names', () => {
    expect(authorFromDisplayName('Christopher D. Manning')).toEqual({ family: 'Manning', given: 'Christopher D.' })
    expect(authorFromDisplayName('Plato')).toEqual({ family: 'Plato' })
  })

  it('normalizes titles for comparison', () => {
    expect(normalizeTitle('Drain: An Online Log-Parsing Approach')).toBe('drain an online log parsing approach')
    expect(normalizeTitle('Anonimización  de  registros')).toBe('anonimizacion de registros')
  })
})
