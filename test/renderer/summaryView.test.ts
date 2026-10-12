import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../../src/shared/jobs'
import type { PaperDetail } from '../../src/shared/library'
import type { ExtractionFile, ExtractionForm, FacetDef, FacetEntry, SummaryFile, ThesisContext } from '../../src/shared/summary'
import { SUMMARY_FIELD_KEYS } from '../../src/shared/summary'
import { cardStatus, facetCards, facetValueText, summarizeAvailability, summaryCards, thesisCard, unfilledFacetKeys } from '../../src/renderer/lib/summaryView'

const ev = (found: boolean) => ({ quote: 'q', page: 1, found })
const text = (value: string) => ({ value, status: 'generated' as const, evidence: [] })

const summary: SummaryFile = {
  schema_version: 1,
  generated: { model: 'sonnet', at: '2026-10-08T00:00:00Z', cost_usd_est: 0.12, prompt_version: 1, language: 'es' },
  fields: {
    // Deliberately out of order: the cards must follow SUMMARY_FIELD_KEYS.
    research_type: { value: 'validation', status: 'generated', evidence: [] },
    limitations: { value: { stated: ['a'], inferred: [] }, status: 'generated', evidence: [] },
    tldr: text('t'),
    problem: text('p'),
    contribution: text('c'),
    method: text('m'),
    evaluation: text('e'),
    results: text('r'),
    future_work: text('f')
  }
}

const form: ExtractionForm = {
  facets: [
    { key: 'domain', type: 'multi', description: 'Domains', values: ['web', 'mobile'] },
    { key: 'venue_type', type: 'single', description: 'Venue', values: ['journal', 'conference'] },
    { key: 'notes', type: 'text', description: 'Notes' },
    { key: 'rigor', type: 'scale', description: 'Rigor', min: 1, max: 5 }
  ],
  value_aliases: {}
}

const entry = (over: Partial<FacetEntry>): FacetEntry => ({ proposed: [], status: 'generated', evidence: [], ...over })

const extraction: ExtractionFile = {
  schema_version: 1,
  form_hash: 'h',
  facets: { rigor: entry({ score: 4, justification: 'solid' }), domain: entry({ values: ['web'] }) }
}

const detail = (over: Partial<PaperDetail>): PaperDetail => ({
  id: 'p1',
  paper: null,
  problem: null,
  problemKind: null,
  hasPdf: true,
  textStatus: 'ok',
  content: null,
  summary: null,
  extraction: null,
  form: null,
  summaryStatus: 'none',
  summaryError: null,
  thesisOutdated: false,
  ...over
})

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 1,
  spec: { type: 'summarize', paperId: 'p1' },
  state: 'queued',
  message: null,
  progress: null,
  paperId: 'p1',
  createdAt: 't',
  updatedAt: 't',
  ...over
})

describe('cardStatus', () => {
  it('flags missing evidence only for generated entries', () => {
    expect(cardStatus({ status: 'generated', evidence: [ev(true), ev(false)] })).toBe('evidence_missing')
    expect(cardStatus({ status: 'generated', evidence: [ev(true)] })).toBe('generated')
    expect(cardStatus({ status: 'verified', evidence: [ev(false)] })).toBe('verified')
    expect(cardStatus({ status: 'edited', evidence: [ev(false)] })).toBe('edited')
  })
})

describe('summaryCards', () => {
  it('follows SUMMARY_FIELD_KEYS', () => {
    const cards = summaryCards(summary)
    expect(cards.map((c) => c.key)).toEqual([...SUMMARY_FIELD_KEYS])
    expect(cards[0].entry).toBe(summary.fields.tldr)
  })
})

describe('facetCards', () => {
  it('follows the form order and includes facets without an entry', () => {
    const cards = facetCards(form, extraction)
    expect(cards.map((c) => c.def.key)).toEqual(['domain', 'venue_type', 'notes', 'rigor'])
    expect(cards[1].entry).toBeNull()
    expect(cards[3].entry?.score).toBe(4)
  })

  it('is empty without a form and gives null entries without an extraction', () => {
    expect(facetCards(null, extraction)).toEqual([])
    expect(facetCards(form, null).every((c) => c.entry === null)).toBe(true)
  })
})

describe('facetValueText', () => {
  const def = (key: string): FacetDef => form.facets.find((f) => f.key === key)!
  it('joins multi values', () => {
    expect(facetValueText(def('domain'), entry({ values: ['web', 'mobile'] }))).toBe('web, mobile')
    expect(facetValueText(def('domain'), entry({ values: [] }))).toBe('—')
  })
  it('shows a single value or a dash', () => {
    expect(facetValueText(def('venue_type'), entry({ value: 'journal' }))).toBe('journal')
    expect(facetValueText(def('venue_type'), entry({ value: null }))).toBe('—')
    expect(facetValueText(def('venue_type'), null)).toBe('—')
  })
  it('shows text', () => {
    expect(facetValueText(def('notes'), entry({ text: 'hello' }))).toBe('hello')
    expect(facetValueText(def('notes'), entry({}))).toBe('—')
  })
  it('shows a scale with its justification', () => {
    expect(facetValueText(def('rigor'), entry({ score: 4, justification: 'solid' }))).toBe('4/5 — solid')
    expect(facetValueText(def('rigor'), entry({ score: 3 }))).toBe('3/5')
    expect(facetValueText(def('rigor'), entry({}))).toBe('—')
  })
})

describe('summarizeAvailability', () => {
  it('needs extracted text', () => {
    expect(summarizeAvailability(detail({ textStatus: 'no_text' }), [])).toBe('no_text')
  })
  it.each(['pending', 'no_source', 'error'] as const)('treats text status %s as no text', (textStatus) => {
    expect(summarizeAvailability(detail({ textStatus }), [])).toBe('no_text')
  })
  it('reports a text over the limit', () => {
    expect(summarizeAvailability(detail({ summaryStatus: 'too_long' }), [])).toBe('too_long')
  })
  it('reports a text over the limit when regenerating an existing summary failed for that reason', () => {
    expect(summarizeAvailability(detail({ summary, summaryStatus: 'failed', summaryError: 'too_long' }), [])).toBe('too_long')
    expect(summarizeAvailability(detail({ summary, summaryStatus: 'failed', summaryError: 'llm_quota' }), [])).toBe('ready')
  })
  it('is running while a summarize job for the paper is queued or running', () => {
    expect(summarizeAvailability(detail({}), [job({ state: 'queued' })])).toBe('running')
    expect(summarizeAvailability(detail({}), [job({ state: 'running' })])).toBe('running')
  })
  it('ignores finished jobs, other papers and other job types', () => {
    const jobs = [
      job({ state: 'done' }),
      job({ spec: { type: 'summarize', paperId: 'other' }, paperId: 'other' }),
      job({ spec: { type: 'update_metadata', paperId: 'p1' } })
    ]
    expect(summarizeAvailability(detail({}), jobs)).toBe('ready')
  })
})

describe('thesisCard', () => {
  const thesis: ThesisContext = { title: 'My thesis', description: '', research_questions: [{ id: 'RQ1', text: 'Why?' }] }
  const relation = { text: 'rel', research_questions: ['RQ1'], score: 4, justification: 'j', status: 'generated' as const, evidence: [] }

  it('asks for a thesis context when the project has none', () => {
    const empty: ThesisContext = { title: ' ', description: '', research_questions: [] }
    expect(thesisCard({ ...extraction, thesis_relation: relation }, empty)).toEqual({ status: 'no_context' })
  })
  it('returns the relation with the thesis questions', () => {
    expect(thesisCard({ ...extraction, thesis_relation: relation }, thesis)).toEqual({ status: 'ok', relation, questions: thesis.research_questions })
  })
  it('has no relation when the extraction lacks one', () => {
    expect(thesisCard(extraction, thesis)).toEqual({ status: 'ok', relation: null, questions: thesis.research_questions })
    expect(thesisCard(null, thesis)).toEqual({ status: 'ok', relation: null, questions: thesis.research_questions })
  })
})

describe('unfilledFacetKeys', () => {
  it('lists the form facets an up-to-date classification has no entry for', () => {
    const partial: ExtractionFile = { schema_version: 1, form_hash: 'h', facets: { domain: entry({ values: ['web'] }) } }
    expect(unfilledFacetKeys(form, partial, 'generated')).toEqual(['venue_type', 'notes', 'rigor'])
    expect(unfilledFacetKeys(form, partial, 'reviewed')).toEqual(['venue_type', 'notes', 'rigor'])
    expect(unfilledFacetKeys(form, partial, 'stale')).toEqual([])
    expect(unfilledFacetKeys(null, partial, 'generated')).toEqual([])
    expect(unfilledFacetKeys(form, null, 'generated')).toEqual([])
  })
})
