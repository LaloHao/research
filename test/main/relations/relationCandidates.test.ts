import { describe, expect, it } from 'vitest'
import type { RelationRow } from '../../../src/main/cache/IndexCache'
import { candidateIndex, coveredFrom, hasNewCandidates, relationCandidates } from '../../../src/main/relations/relationCandidates'

const row = (id: string, openalex: string | null): RelationRow => ({
  id,
  title: `Title ${id}`,
  year: 2020,
  doi: null,
  openalex_id: openalex,
  cited_by_count: null,
  citations_status: 'ok',
  thesis_score: null
})
const rows = [row('a1', 'W1'), row('b1', 'W2'), row('c1', 'W3'), row('d1', null)]
const edges = [
  { citing: 'a1', cited: 'W2' },
  { citing: 'a1', cited: 'W9' },
  { citing: 'c1', cited: 'W1' }
]
const similar = [
  { other: 'd1', score: 0.8 },
  { other: 'b1', score: 0.5 },
  { other: 'gone', score: 0.9 }
]
const index = candidateIndex(rows, edges)

describe('relationCandidates', () => {
  it('puts papers linked by citations first, then the most similar ones, without duplicates or unknown papers', () => {
    expect(relationCandidates('a1', index, similar)).toEqual([
      { id: 'b1', title: 'Title b1', year: 2020, via: ['cites', 'similar'], score: 0.5 },
      { id: 'c1', title: 'Title c1', year: 2020, via: ['cited_by'], score: null },
      { id: 'd1', title: 'Title d1', year: 2020, via: ['similar'], score: 0.8 }
    ])
  })

  it('caps the list and returns nothing for an unknown paper', () => {
    expect(relationCandidates('a1', index, similar, 2).map((c) => c.id)).toEqual(['b1', 'c1'])
    expect(relationCandidates('zz9', index, similar)).toEqual([])
  })
})

describe('analysis bookkeeping', () => {
  const at = '2026-10-10T00:00:00.000Z'

  it('knows which pairs were already looked at from the other side', () => {
    expect([...coveredFrom({ b1: { candidates: ['a1', 'c1'], at }, c1: { candidates: ['d1'], at } }, 'a1')]).toEqual(['b1'])
  })

  it('asks for a new analysis only when a candidate appears that the last analysis did not see', () => {
    expect(hasNewCandidates(['b1'], undefined)).toBe(true)
    expect(hasNewCandidates(['b1'], { candidates: ['b1', 'c1'], at })).toBe(false)
    expect(hasNewCandidates(['b1', 'd1'], { candidates: ['b1'], at })).toBe(true)
    expect(hasNewCandidates([], undefined)).toBe(false)
  })
})
