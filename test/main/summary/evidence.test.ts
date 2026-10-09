import { describe, expect, it } from 'vitest'
import { checkEvidence, locateQuote } from '../../../src/main/summary/evidence'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'

const pages = [
  { page: 1, text: 'We study personally identifiable information in production logs.' },
  { page: 4, text: 'For detection, we fine-tune a BERT model on 12k annotated log lines.' }
]

describe('locateQuote', () => {
  it('confirms a quote on its hinted page', () => {
    expect(locateQuote('we fine-tune a BERT model', pages, 4)).toEqual({ page: 4, found: true })
  })

  it('corrects the page when the quote is elsewhere', () => {
    expect(locateQuote('personally identifiable information in production logs', pages, 4)).toEqual({ page: 1, found: true })
  })

  it('keeps the hint and flags an invented quote', () => {
    expect(locateQuote('we train GPT on synthetic data', pages, 2)).toEqual({ page: 2, found: false })
  })

  it('works for page-less web text', () => {
    expect(locateQuote('fine-tune a BERT', [{ page: null, text: pages[1].text }], null)).toEqual({ page: null, found: true })
  })
})

describe('checkEvidence', () => {
  it('marks generated evidence and leaves verified fields untouched', () => {
    const summary = sampleSummary({
      method: { value: 'BERT', status: 'generated', evidence: [{ quote: 'we fine-tune a BERT model', page: 2, found: false }] },
      problem: { value: 'p', status: 'verified', evidence: [{ quote: 'made up', page: 9, found: false }] }
    })
    const extraction = sampleExtraction({ technique: { values: ['ner'], proposed: [], status: 'generated', evidence: [{ quote: 'invented', page: 1, found: false }] } })
    const r = checkEvidence(summary, extraction, pages)
    expect(r.summary.fields.method.evidence[0]).toEqual({ quote: 'we fine-tune a BERT model', page: 4, found: true })
    expect(r.summary.fields.problem.evidence[0]).toEqual({ quote: 'made up', page: 9, found: false })
    expect(r.extraction.facets.technique.evidence[0].found).toBe(false)
    expect(r).toMatchObject({ found: 1, total: 2 })
  })
})
