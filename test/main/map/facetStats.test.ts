import { describe, expect, it } from 'vitest'
import { barCounts, bubbleCounts, chartData, facetRowsFor, papersMatching, yearCounts, type FacetRow } from '../../../src/main/map/facetStats'
import type { FacetDef } from '../../../src/shared/summary'
import { sampleExtraction } from '../../helpers/summaries'

const defs: FacetDef[] = [
  { key: 'technique', type: 'multi', description: 'd', values: ['ner', 'regex', 'llm'] },
  { key: 'llm_usage', type: 'single', description: 'd', values: ['none', 'local'] },
  { key: 'notes', type: 'text', description: 'd' },
  { key: 'relevance', type: 'scale', description: 'd', min: 1, max: 5 }
]

const row = (paperId: string, facet: string, value: string, reviewed = false, year: number | null = 2020): FacetRow => ({ paperId, facet, value, reviewed, year })

describe('facetRowsFor', () => {
  it('keeps single/multi entries that fit their facet, with their review state', () => {
    const extraction = sampleExtraction({
      technique: { values: ['ner', 'ner', 'regex'], proposed: [], status: 'verified', evidence: [] },
      llm_usage: { value: 'local', proposed: [], status: 'generated', evidence: [] },
      notes: { text: 'x', proposed: [], status: 'edited', evidence: [] }
    })
    expect(facetRowsFor(extraction, defs)).toEqual([
      { facet: 'technique', value: 'ner', reviewed: true },
      { facet: 'technique', value: 'regex', reviewed: true },
      { facet: 'llm_usage', value: 'local', reviewed: false }
    ])
  })

  it('ignores entries that no longer fit the facet type, empty singles and missing forms', () => {
    const extraction = sampleExtraction({
      technique: { text: 'old text entry', proposed: [], status: 'verified', evidence: [] },
      llm_usage: { value: null, proposed: [], status: 'generated', evidence: [] }
    })
    expect(facetRowsFor(extraction, defs)).toEqual([])
    expect(facetRowsFor(extraction, null)).toEqual([])
    expect(facetRowsFor(null, defs)).toEqual([])
  })
})

describe('chart aggregates', () => {
  const rows = [
    row('a', 'technique', 'ner', true),
    row('a', 'technique', 'regex', false),
    row('b', 'technique', 'ner', false, 2021),
    row('c', 'technique', 'llm', true, null),
    row('a', 'llm_usage', 'local', true),
    row('b', 'llm_usage', 'none', true, 2021)
  ]

  it('counts papers per value, split by review state', () => {
    expect(barCounts(rows, 'technique', false)).toEqual([
      { value: 'ner', reviewed: 1, unreviewed: 1 },
      { value: 'llm', reviewed: 1, unreviewed: 0 },
      { value: 'regex', reviewed: 0, unreviewed: 1 }
    ])
    expect(barCounts(rows, 'technique', true)).toEqual([
      { value: 'llm', reviewed: 1, unreviewed: 0 },
      { value: 'ner', reviewed: 1, unreviewed: 0 }
    ])
  })

  it('crosses two facets, keeping values without a pair on the axes', () => {
    expect(bubbleCounts(rows, 'technique', 'llm_usage', false)).toEqual({
      kind: 'bubbles',
      facet: 'technique',
      facetY: 'llm_usage',
      xValues: ['ner', 'llm', 'regex'],
      yValues: ['local', 'none'],
      cells: [
        { x: 'ner', y: 'local', reviewed: 1, unreviewed: 0 },
        { x: 'ner', y: 'none', reviewed: 0, unreviewed: 1 },
        { x: 'regex', y: 'local', reviewed: 0, unreviewed: 1 }
      ]
    })
  })

  it('counts per year and skips papers without one', () => {
    expect(yearCounts(rows, 'technique', false)).toEqual([
      { year: 2020, value: 'ner', reviewed: 1, unreviewed: 0 },
      { year: 2020, value: 'regex', reviewed: 0, unreviewed: 1 },
      { year: 2021, value: 'ner', reviewed: 0, unreviewed: 1 }
    ])
  })

  it('dispatches on the chart kind', () => {
    expect(chartData(rows, { kind: 'bars', facet: 'llm_usage', onlyReviewed: true })).toEqual({
      kind: 'bars',
      facet: 'llm_usage',
      bars: [
        { value: 'local', reviewed: 1, unreviewed: 0 },
        { value: 'none', reviewed: 1, unreviewed: 0 }
      ]
    })
    expect(chartData(rows, { kind: 'years', facet: 'llm_usage', onlyReviewed: false })).toMatchObject({ kind: 'years', facet: 'llm_usage' })
  })

  it('finds the papers matching every facet filter', () => {
    expect(papersMatching(rows, [{ facet: 'technique', value: 'ner' }])).toEqual(['a', 'b'])
    expect(papersMatching(rows, [{ facet: 'technique', value: 'ner' }, { facet: 'llm_usage', value: 'none' }])).toEqual(['b'])
    expect(papersMatching(rows, [])).toEqual([])
  })
})
