import { describe, expect, it } from 'vitest'
import {
  acceptProposed,
  addAlias,
  addFacetValue,
  countPending,
  editFacet,
  editField,
  InvalidEdit,
  mapProposed,
  mergeExtraction,
  mergeSummary,
  setFieldStatus,
  summarySearchText,
  summaryState,
  verifyAll
} from '../../../src/main/summary/merge'
import type { ExtractionForm } from '../../../src/shared/summary'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'

const form: ExtractionForm = {
  facets: [
    { key: 'technique', type: 'multi', description: 'd', values: ['ner'] },
    { key: 'llm_usage', type: 'single', description: 'd', values: ['none', 'local'] },
    { key: 'relevance', type: 'scale', description: 'd', min: 1, max: 5 }
  ],
  value_aliases: {}
}

describe('mergeSummary', () => {
  it('replaces generated fields and keeps verified and edited ones', () => {
    const existing = sampleSummary({
      tldr: { value: 'mine', status: 'edited', evidence: [] },
      method: { value: 'checked', status: 'verified', evidence: [] }
    })
    const generated = sampleSummary({ tldr: { value: 'new', status: 'generated', evidence: [] }, method: { value: 'new', status: 'generated', evidence: [] }, problem: { value: 'new p', status: 'generated', evidence: [] } })
    const merged = mergeSummary(existing, generated)
    expect(merged.fields.tldr.value).toBe('mine')
    expect(merged.fields.method.value).toBe('checked')
    expect(merged.fields.problem.value).toBe('new p')
  })

  it('takes the generated summary as is when there was none', () => {
    const g = sampleSummary()
    expect(mergeSummary(null, g)).toEqual(g)
  })
})

describe('mergeExtraction', () => {
  it('keeps user decisions and facets removed from the form, and updates the hash', () => {
    const existing = sampleExtraction(
      { old_facet: { text: 'kept', proposed: [], status: 'generated', evidence: [] }, technique: { values: ['ner'], proposed: [], status: 'verified', evidence: [] } },
      'old'
    )
    const generated = sampleExtraction({ technique: { values: [], proposed: ['x'], status: 'generated', evidence: [] } }, 'new')
    const merged = mergeExtraction(existing, generated)
    expect(merged.form_hash).toBe('new')
    expect(merged.facets.technique.values).toEqual(['ner'])
    expect(merged.facets.old_facet.text).toBe('kept')
  })
})

describe('status changes and edits', () => {
  it('verifies and unverifies a field', () => {
    const s = setFieldStatus(sampleSummary(), 'method', 'verified')
    expect(s.fields.method.status).toBe('verified')
    expect(setFieldStatus(s, 'method', 'generated').fields.method.status).toBe('generated')
  })

  it('does not turn an edited field back into generated', () => {
    const s = editField(sampleSummary(), 'tldr', 'mine')
    expect(setFieldStatus(s, 'tldr', 'generated').fields.tldr.status).toBe('edited')
    expect(setFieldStatus(s, 'tldr', 'verified').fields.tldr.status).toBe('verified')
  })

  it('validates edited values by field type', () => {
    expect(editField(sampleSummary(), 'limitations', { stated: ['a'], inferred: [] }).fields.limitations.status).toBe('edited')
    expect(() => editField(sampleSummary(), 'research_type', 'essay')).toThrow(InvalidEdit)
    expect(() => editField(sampleSummary(), 'tldr', 42)).toThrow(InvalidEdit)
  })

  it('validates facet edits against the form', () => {
    const e = sampleExtraction({ technique: { values: [], proposed: [], status: 'generated', evidence: [] } })
    expect(editFacet(e, form, 'technique', { values: ['ner'] }).facets.technique).toMatchObject({ values: ['ner'], status: 'edited' })
    expect(() => editFacet(e, form, 'technique', { values: ['unknown'] })).toThrow(InvalidEdit)
    expect(() => editFacet(e, form, 'relevance', { score: 7, justification: 'x' })).toThrow(InvalidEdit)
  })

  it('verifies everything that is still generated', () => {
    const r = verifyAll(sampleSummary({ tldr: { value: 'x', status: 'edited', evidence: [] } }), sampleExtraction())
    expect(r.summary!.fields.method.status).toBe('verified')
    expect(r.summary!.fields.tldr.status).toBe('edited')
    expect(r.extraction!.facets.relevance.status).toBe('verified')
  })
})

describe('proposed values', () => {
  const e = sampleExtraction({
    technique: { values: ['ner'], proposed: ['tokenization'], status: 'generated', evidence: [] },
    llm_usage: { value: null, proposed: ['hybrid'], status: 'verified', evidence: [] }
  })

  it('accepting moves the proposal into the values without changing the status', () => {
    expect(acceptProposed(e, 'technique', 'tokenization')!.facets.technique).toMatchObject({ values: ['ner', 'tokenization'], proposed: [], status: 'generated' })
    expect(acceptProposed(e, 'llm_usage', 'hybrid')!.facets.llm_usage).toMatchObject({ value: 'hybrid', proposed: [], status: 'verified' })
    expect(acceptProposed(e, 'technique', 'absent')).toBeNull()
  })

  it('mapping replaces the proposal with an existing value', () => {
    expect(mapProposed(e, 'technique', 'tokenization', 'ner')!.facets.technique).toMatchObject({ values: ['ner'], proposed: [] })
  })

  it('updates the form', () => {
    expect(addFacetValue(form, 'technique', 'tokenization').facets[0]).toMatchObject({ values: ['ner', 'tokenization'] })
    expect(addAlias(form, 'technique', 'tokenization', 'ner').value_aliases).toEqual({ technique: { tokenization: 'ner' } })
  })
})

describe('summaryState', () => {
  const base = { summary: null, extraction: null, formHash: 'h', textChars: 100, maxChars: 1000, error: null }

  it.each([
    [{}, 'none'],
    [{ textChars: 5000 }, 'too_long'],
    [{ error: 'llm_quota' }, 'failed'],
    [{ summary: sampleSummary(), extraction: sampleExtraction({}, 'h') }, 'generated'],
    [{ summary: sampleSummary(), extraction: sampleExtraction({}, 'other') }, 'stale']
  ])('%o → %s', (over, expected) => {
    expect(summaryState({ ...base, ...over })).toBe(expected)
  })

  it('is reviewed when nothing is pending', () => {
    const v = verifyAll(sampleSummary(), sampleExtraction({}, 'h'))
    expect(summaryState({ ...base, summary: v.summary, extraction: v.extraction })).toBe('reviewed')
    expect(countPending(v.summary, v.extraction)).toBe(0)
    expect(countPending(sampleSummary(), sampleExtraction())).toBe(10)
  })
})

describe('summarySearchText', () => {
  it('collects every text value', () => {
    const text = summarySearchText(sampleSummary({ method: { value: 'pseudonymization', status: 'generated', evidence: [] } }), sampleExtraction())
    expect(text).toContain('pseudonymization')
    expect(text).toContain('j')
  })
})
