import { describe, expect, it } from 'vitest'
import { computeCandidates, type CandidateInput } from '../../../src/main/citations/candidates'
import type { ExternalWork } from '../../../src/shared/relations'

const work = (openalexId: string, over: Partial<ExternalWork> = {}): ExternalWork => ({ openalexId, title: openalexId, year: 2020, authors: '', doi: null, citedByCount: 0, ...over })

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    references: [
      { citing: 'a', cited: 'W10' },
      { citing: 'b', cited: 'W10' },
      { citing: 'a', cited: 'W11' },
      { citing: 'a', cited: 'W2' },
      { citing: 'a', cited: 'W12' },
      { citing: 'b', cited: 'W12' }
    ],
    incoming: [
      { paperId: 'a', citing: 'W20' },
      { paperId: 'b', citing: 'W20' },
      { paperId: 'a', citing: 'W1' }
    ],
    library: [
      { id: 'a', openalexId: 'W1', doi: '10.1/a' },
      { id: 'b', openalexId: 'W2', doi: null }
    ],
    dismissed: new Set(),
    works: new Map(),
    ...over
  }
}

const ids = (i: CandidateInput, q: Parameters<typeof computeCandidates>[1]) => computeCandidates(i, q).map((c) => c.openalexId)

describe('computeCandidates', () => {
  it('lists external references cited by at least N library papers, never library papers', () => {
    expect(ids(input(), { direction: 'references', minCount: 2 })).toEqual(['W10', 'W12'])
    expect(computeCandidates(input(), { direction: 'references', minCount: 2 })[0]).toEqual({
      openalexId: 'W10',
      work: null,
      citedByLibrary: 2,
      citesLibrary: 0,
      paperIds: ['a', 'b']
    })
  })

  it('lists external works citing at least N library papers', () => {
    expect(ids(input(), { direction: 'citing', minCount: 2 })).toEqual(['W20'])
  })

  it('combines both directions, then filters by paper', () => {
    expect(ids(input(), { direction: 'all', minCount: 1 })).toEqual(['W10', 'W12', 'W20', 'W11'])
    expect(ids(input(), { direction: 'all', minCount: 1, paperId: 'b' })).toEqual(['W10', 'W12', 'W20'])
  })

  it('drops dismissed candidates and works whose DOI is already in the library', () => {
    const works = new Map([['W12', work('W12', { doi: '10.1/A' })]])
    expect(ids(input({ dismissed: new Set(['W10']), works }), { direction: 'references', minCount: 2 })).toEqual([])
  })

  it('breaks ties by total citations in OpenAlex', () => {
    const works = new Map([
      ['W10', work('W10', { citedByCount: 5 })],
      ['W12', work('W12', { citedByCount: 50 })]
    ])
    expect(ids(input({ works }), { direction: 'references', minCount: 2 })).toEqual(['W12', 'W10'])
  })
})
