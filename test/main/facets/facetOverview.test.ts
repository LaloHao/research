import { describe, expect, it } from 'vitest'
import { computeFacetOverview, facetEntryValue } from '../../../src/main/facets/facetOverview'
import type { ExtractionFile, ExtractionForm, FacetEntry } from '../../../src/shared/summary'

const entry = (over: Partial<FacetEntry>): FacetEntry => ({ proposed: [], status: 'generated', evidence: [], ...over })
const ext = (facets: ExtractionFile['facets']): ExtractionFile => ({ schema_version: 1, form_hash: 'h', facets })

const form: ExtractionForm = {
  facets: [
    { key: 'technique', type: 'multi', description: 'T', values: ['ner'] },
    { key: 'rigor', type: 'scale', description: 'R', min: 1, max: 5 }
  ],
  value_aliases: { technique: { regex: 'ner' } }
}

describe('computeFacetOverview', () => {
  it('counts values and scores, lists unassigned proposals with their papers, and skips entries that no longer fit', () => {
    const overview = computeFacetOverview(form, [
      { paperId: 'b2020x', extraction: ext({ technique: entry({ values: ['ner'], proposed: ['llm_based', 'regex'] }), rigor: entry({ score: 4 }) }) },
      { paperId: 'a2020x', extraction: ext({ technique: entry({ values: [], proposed: ['llm_based', 'ner'] }), rigor: entry({ text: 'was a text facet once' }) }) }
    ])
    expect(overview).toEqual({
      papers: 2,
      facets: [
        { key: 'technique', type: 'multi', description: 'T', allowed: ['ner'], filled: 2, values: [{ value: 'ner', papers: 1 }], proposed: [{ value: 'llm_based', papers: ['a2020x', 'b2020x'] }] },
        { key: 'rigor', type: 'scale', description: 'R', allowed: [], filled: 1, values: [{ value: '4', papers: 1 }], proposed: [] }
      ]
    })
  })

  it('gives a facet entry its value by type', () => {
    expect(facetEntryValue({ key: 'a', type: 'single', description: 'd', values: ['x'] }, entry({ value: null }))).toBeNull()
    expect(facetEntryValue({ key: 'a', type: 'multi', description: 'd', values: ['x'] }, entry({ values: ['x'] }))).toEqual(['x'])
    expect(facetEntryValue({ key: 'a', type: 'text', description: 'd' }, entry({ text: 'hi' }))).toBe('hi')
    expect(facetEntryValue({ key: 'a', type: 'scale', description: 'd', min: 1, max: 5 }, entry({ score: 3, justification: 'j' }))).toEqual({ score: 3, justification: 'j' })
  })
})
