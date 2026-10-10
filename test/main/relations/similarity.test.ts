import { describe, expect, it } from 'vitest'
import {
  combine,
  cosine,
  internalCiters,
  jaccard,
  neighbours,
  neighboursOf,
  pairSignals,
  reasons,
  updateNeighbours,
  WEIGHTS,
  type PaperSignals,
  type ScoredPair
} from '../../../src/main/relations/similarity'

function p(id: string, openalexId: string | null, refs: string[] = [], facets: Record<string, string[]> = {}, vector: number[] | null = null): PaperSignals {
  return {
    id,
    openalexId,
    references: new Set(refs),
    facets: new Map(Object.entries(facets).map(([k, v]) => [k, new Set(v)])),
    vector: vector ? new Float32Array(vector) : null
  }
}

describe('similarity signals', () => {
  it('computes Jaccard and cosine', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
    expect(jaccard(new Set(), new Set())).toBe(0)
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1)
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0)
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0)
  })

  it('counts shared references (bibliographic coupling)', () => {
    const s = pairSignals(p('a', 'W1', ['W7', 'W8', 'W9']), p('b', 'W2', ['W8', 'W9']), new Map())
    expect(s.sharedRefs).toBe(2)
    expect(s.coupling).toBeCloseTo(2 / 3)
    expect(reasons(s)).toEqual([{ kind: 'coupling', shared: 2 }])
  })

  it('counts library papers that cite both (co-citation)', () => {
    const papers = [p('a', 'W1'), p('b', 'W2'), p('c', 'W3', ['W1', 'W2']), p('d', 'W4', ['W1', 'W2'])]
    const citers = internalCiters(papers)
    expect([...citers.get('a')!].sort()).toEqual(['c', 'd'])
    const s = pairSignals(papers[0], papers[1], citers)
    expect(s.cocitedBy).toBe(2)
    expect(s.cocitation).toBeCloseTo(1)
    expect(reasons(s)).toContainEqual({ kind: 'cocitation', by: 2 })
  })

  it('detects a direct citation in either direction', () => {
    const s = pairSignals(p('a', 'W1'), p('b', 'W2', ['W1']), new Map())
    expect(s.direct).toEqual({ citing: 'b', cited: 'a' })
    expect(reasons(s)).toContainEqual({ kind: 'direct', citing: 'b', cited: 'a' })
  })

  it('averages the Jaccard of the facets both papers have', () => {
    const s = pairSignals(
      p('a', 'W1', [], { technique: ['ner', 'regex'], task: ['anonymization'], data: ['logs'] }),
      p('b', 'W2', [], { technique: ['ner'], task: ['log_parsing'] }),
      new Map()
    )
    expect(s.facets).toBeCloseTo(0.25)
    expect(s.sharedFacets).toEqual([{ facet: 'technique', values: ['ner'] }])
  })

  it('uses the content cosine only above the floor, and shows it as a reason', () => {
    const s = pairSignals(p('a', 'W1', [], {}, [1, 0]), p('b', 'W2', [], {}, [0.9, 0.1]), new Map())
    expect(s.cosine).toBeCloseTo(0.9939, 3)
    expect(reasons(s)).toEqual([{ kind: 'content', cosine: 0.99 }])
    const low = pairSignals(p('a', 'W1', [], {}, [1, 0]), p('b', 'W2', [], {}, [0.5, 0.5]), new Map())
    expect(reasons(low)).toEqual([])
  })
})

describe('combined score', () => {
  it('weights every signal and renormalizes when a paper has no vector', () => {
    const both = pairSignals(p('a', 'W1', ['W7'], {}, [1, 0]), p('b', 'W2', ['W7'], {}, [1, 0]), new Map())
    expect(combine(both)).toBeCloseTo(WEIGHTS.content + WEIGHTS.coupling)
    const noVectors = pairSignals(p('a', 'W1', ['W7']), p('b', 'W2', ['W7'], {}, [1, 0]), new Map())
    expect(combine(noVectors)).toBeCloseTo(WEIGHTS.coupling / (1 - WEIGHTS.content))
  })

  it('accepts other weights (used by the evaluation)', () => {
    const s = pairSignals(p('a', 'W1', ['W7']), p('b', 'W2', ['W7']), new Map())
    expect(combine(s, { content: 0, coupling: 1, facets: 0, cocitation: 0, direct: 0 })).toBe(1)
  })
})

describe('neighbours', () => {
  it('keeps the k best neighbours of each paper and skips unrelated pairs', () => {
    const papers = [p('a', 'W1', ['W7', 'W8']), p('b', 'W2', ['W7', 'W8']), p('c', 'W3', ['W7']), p('d', 'W4', ['W99'])]
    const pairs = neighbours(papers, 1)
    expect(pairs.filter((x) => x.a === 'a')).toEqual([expect.objectContaining({ a: 'a', b: 'b', reasons: [{ kind: 'coupling', shared: 2 }] })])
    expect(pairs.filter((x) => x.a === 'c')).toEqual([expect.objectContaining({ a: 'c', b: 'a' })])
    expect(pairs.some((x) => x.a === 'd' || x.b === 'd')).toBe(false)
  })

  it('computes one row on its own exactly as the full computation does', () => {
    const papers = [p('a', 'W1', ['W7'], { task: ['x', 'y'] }, [1, 0]), p('b', 'W2', ['W7', 'W1'], { task: ['y', 'x'] }, [0.9, 0.1]), p('c', 'W3', ['W7'])]
    expect(neighboursOf(papers[1], papers, internalCiters(papers), 10)).toEqual(neighbours(papers, 10).filter((x) => x.a === 'b'))
  })
})

describe('incremental update', () => {
  const library = (): PaperSignals[] => [
    p('a', 'W1', ['W7', 'W8'], { task: ['x'] }, [1, 0, 0]),
    p('b', 'W2', ['W7'], { task: ['x', 'y'] }, [0.9, 0.1, 0]),
    p('c', 'W3', ['W1', 'W2', 'W8'], {}, [0, 1, 0]),
    p('d', 'W4', ['W1'], { task: ['y'] }, [0.8, 0.2, 0.1]),
    p('e', 'W5', ['W9'], {}, [0, 0.9, 0.3]),
    p('f', 'W6', ['W7', 'W9'], { task: ['x'] }, null)
  ]

  function rowsOf(pairs: ScoredPair[]): Map<string, ScoredPair[]> {
    const rows = new Map<string, ScoredPair[]>()
    for (const pair of pairs) rows.set(pair.a, [...(rows.get(pair.a) ?? []), pair])
    return rows
  }

  /** Applies the incremental update to the rows of `before` and compares with a full computation over `after`. */
  function check(before: PaperSignals[], after: PaperSignals[], changedId: string, k: number): void {
    const rows = rowsOf(neighbours(before, k))
    for (const [id, row] of updateNeighbours(after, before.find((x) => x.id === changedId) ?? null, changedId, rows, k)) rows.set(id, row)
    for (const [id, row] of [...rows]) if (row.length === 0 || !after.some((x) => x.id === id)) rows.delete(id)
    const sorted = (m: Map<string, ScoredPair[]>) => new Map([...m].sort(([x], [y]) => x.localeCompare(y)))
    expect(sorted(rows)).toEqual(sorted(rowsOf(neighbours(after, k))))
  }

  it.each([1, 2, 3, 10])('matches a full recompute for every kind of change (k=%i)', (k) => {
    const gainsReferences = library()
    gainsReferences[4] = p('e', 'W5', ['W9', 'W1', 'W2'], {}, [0, 0.9, 0.3])
    check(library(), gainsReferences, 'e', k)
    const newVector = library()
    newVector[0] = p('a', 'W1', ['W7', 'W8'], { task: ['x'] }, [0, 1, 0])
    check(library(), newVector, 'a', k)
    const losesReferences = library()
    losesReferences[2] = p('c', 'W3', [], {}, [0, 1, 0])
    check(library(), losesReferences, 'c', k)
    const everything = library()
    everything[5] = p('f', 'W6', ['W7', 'W9', 'W3'], { task: ['y'] }, [0.85, 0.15, 0])
    check(library(), everything, 'f', k)
    check(library(), library().filter((x) => x.id !== 'c'), 'c', k)
    check(library().filter((x) => x.id !== 'd'), library(), 'd', k)
  })
})
