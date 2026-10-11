import { describe, expect, it } from 'vitest'
import { computeCandidates, type CandidateInput } from '../../../src/main/citations/candidates'

describe('candidates and the trash', () => {
  it('marks a work that is a paper in the trash, by OpenAlex id or by DOI', () => {
    const input: CandidateInput = {
      references: [
        { citing: 'a1', cited: 'W1' },
        { citing: 'a1', cited: 'W2' },
        { citing: 'a1', cited: 'W3' }
      ],
      incoming: [],
      library: [{ id: 'a1', openalexId: 'W9', doi: null }],
      dismissed: new Set(),
      works: new Map([['W2', { openalexId: 'W2', title: 'B', year: 2020, authors: '', doi: '10.1/b', citedByCount: 0 }]]),
      trash: [
        { id: 'x2017one', openalexId: 'W1', doi: null },
        { id: 'y2020two', openalexId: null, doi: '10.1/B' }
      ]
    }
    expect(computeCandidates(input, { direction: 'references', minCount: 1 }).map((c) => [c.openalexId, c.trashedId])).toEqual([
      ['W1', 'x2017one'],
      ['W2', 'y2020two'],
      ['W3', undefined]
    ])
  })
})
