import { describe, expect, it } from 'vitest'
import {
  acceptProposed,
  addAlias,
  addFacetValue,
  countPending,
  editFacet,
  editField,
  entryFitsFacet,
  InvalidEdit,
  mapProposed,
  mergeExtraction,
  mergeSummary,
  setFieldStatus,
  setThesisStatus,
  summarySearchText,
  summaryState,
  verifyAll
} from '../../../src/main/summary/merge'
import type { ExtractionForm } from '../../../src/shared/summary'
import { sampleExtraction, sampleSummary } from '../../helpers/summaries'
import type { ThesisRelation } from '../../../src/shared/summary'

const relation = (status: ThesisRelation['status'], text = 'rel'): ThesisRelation => ({
  text,
  research_questions: ['RQ1'],
  score: 3,
  justification: 'because RQ1',
  status,
  evidence: []
})

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
  const base = { summary: null, extraction: null, formHash: 'h', thesisHash: null, textChars: 100, maxChars: 1000, error: null }

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

  it('ignores pending facets that are no longer in the form', () => {
    const v = verifyAll(sampleSummary(), sampleExtraction({}, 'h'))
    const removed = { score: 3, justification: 'j', proposed: [], status: 'generated' as const, evidence: [] }
    const e = { ...v.extraction!, facets: { ...v.extraction!.facets, old_facet: removed } }
    expect(countPending(v.summary, e)).toBe(1)
    expect(countPending(v.summary, e, ['relevance'])).toBe(0)
    expect(summaryState({ ...base, summary: v.summary, extraction: e, facetKeys: ['relevance'] })).toBe('reviewed')
  })
})

describe('summarySearchText', () => {
  it('collects every text value', () => {
    const text = summarySearchText(sampleSummary({ method: { value: 'pseudonymization', status: 'generated', evidence: [] } }), sampleExtraction())
    expect(text).toContain('pseudonymization')
    expect(text).toContain('j')
  })
})

describe('thesis relation', () => {
  it('mergeExtraction keeps a verified or edited relation with the thesis hash it was reviewed against', () => {
    const existing = { ...sampleExtraction(), thesis_relation: relation('verified', 'mine'), thesis_hash: 'old' }
    const generated = { ...sampleExtraction(), thesis_relation: relation('generated', 'new'), thesis_hash: 'new' }
    const merged = mergeExtraction(existing, generated)
    expect(merged.thesis_relation?.text).toBe('mine')
    expect(merged.thesis_hash).toBe('old')
    const edited = mergeExtraction({ ...existing, thesis_relation: relation('edited', 'mine') }, generated)
    expect(edited.thesis_relation?.text).toBe('mine')
    expect(edited.thesis_hash).toBe('old')
  })

  it('mergeExtraction replaces a generated relation and takes the new thesis hash', () => {
    const existing = { ...sampleExtraction(), thesis_relation: relation('generated', 'old'), thesis_hash: 'old' }
    const generated = { ...sampleExtraction(), thesis_relation: relation('generated', 'new'), thesis_hash: 'new' }
    const merged = mergeExtraction(existing, generated)
    expect(merged.thesis_relation?.text).toBe('new')
    expect(merged.thesis_hash).toBe('new')
    expect(mergeExtraction(sampleExtraction(), generated).thesis_hash).toBe('new')
  })

  it('counts, verifies and indexes the relation', () => {
    const e = { ...sampleExtraction(), thesis_relation: relation('generated', 'sanitization matters') }
    expect(countPending(null, e)).toBe(2)
    expect(verifyAll(null, e).extraction!.thesis_relation?.status).toBe('verified')
    expect(summarySearchText(null, e)).toContain('sanitization matters')
    expect(summarySearchText(null, e)).toContain('because RQ1')
  })

  it('setThesisStatus verifies and reopens, but never un-edits', () => {
    const e = { ...sampleExtraction(), thesis_relation: relation('generated') }
    const v = setThesisStatus(e, 'verified')
    expect(v.thesis_relation?.status).toBe('verified')
    expect(setThesisStatus(v, 'generated').thesis_relation?.status).toBe('generated')
    expect(setThesisStatus({ ...e, thesis_relation: relation('edited') }, 'generated').thesis_relation?.status).toBe('edited')
    expect(() => setThesisStatus(sampleExtraction(), 'verified')).toThrow(InvalidEdit)
  })

  it('summaryState is stale when the thesis hash changes, and ignores it without a context', () => {
    const base = { summary: sampleSummary(), formHash: 'h', textChars: 100, maxChars: 1000, error: null }
    const e = { ...sampleExtraction({}, 'h'), thesis_hash: 't1' }
    expect(summaryState({ ...base, extraction: e, thesisHash: 't1' })).toBe('generated')
    expect(summaryState({ ...base, extraction: e, thesisHash: 't2' })).toBe('stale')
    expect(summaryState({ ...base, extraction: sampleExtraction({}, 'h'), thesisHash: 't1' })).toBe('stale')
    expect(summaryState({ ...base, extraction: sampleExtraction({}, 'h'), thesisHash: null })).toBe('generated')
  })

  it('a reviewed relation made against another thesis waits for review instead of making the paper stale', () => {
    const base = { formHash: 'h', textChars: 100, maxChars: 1000, error: null }
    const v = verifyAll(sampleSummary(), { ...sampleExtraction({}, 'h'), thesis_relation: relation('generated'), thesis_hash: 't1' })
    expect(summaryState({ ...base, ...v, thesisHash: 't1' })).toBe('reviewed')
    expect(summaryState({ ...base, ...v, thesisHash: 't2' })).toBe('generated')
    expect(countPending(v.summary, v.extraction, null, 't2')).toBe(1)
    expect(countPending(v.summary, v.extraction, null, 't1')).toBe(0)
  })
})

describe('entryFitsFacet', () => {
  const single = { key: 'llm_usage', type: 'single' as const, description: 'd', values: ['none', 'local'] }
  const multi = { key: 'technique', type: 'multi' as const, description: 'd', values: ['ner'] }
  const text = { key: 'traceability', type: 'text' as const, description: 'd' }
  const scale = { key: 'relevance', type: 'scale' as const, description: 'd', min: 1, max: 5 }
  const base = { proposed: [], status: 'generated' as const, evidence: [] }

  it('matches an entry whose stored shape fits the facet type', () => {
    expect(entryFitsFacet(single, { ...base, value: 'none' })).toBe(true)
    expect(entryFitsFacet(multi, { ...base, values: ['ner'] })).toBe(true)
    expect(entryFitsFacet(text, { ...base, text: 't' })).toBe(true)
    expect(entryFitsFacet(scale, { ...base, score: 3, justification: 'j' })).toBe(true)
  })

  it('rejects an entry stored under a different facet type, e.g. after the facet was recreated', () => {
    expect(entryFitsFacet(scale, { ...base, text: 't' })).toBe(false)
    expect(entryFitsFacet(text, { ...base, score: 3, justification: 'j' })).toBe(false)
    expect(entryFitsFacet(single, { ...base, values: ['ner'] })).toBe(false)
    expect(entryFitsFacet(multi, { ...base, value: 'none' })).toBe(false)
  })
})

describe('type-mismatched facet entries are treated as absent', () => {
  const scale = { key: 'rigor', type: 'scale' as const, description: 'd', min: 1, max: 5 }
  const defs = [scale]
  // An old `text` entry left over from before the facet was removed and recreated as a scale.
  const mismatched = { text: 'old text value', proposed: [], status: 'verified' as const, evidence: [] }

  it('mergeExtraction replaces it even though it was verified, only when given the current facet defs', () => {
    const existing = sampleExtraction({ rigor: mismatched }, 'old')
    const generated = sampleExtraction({ rigor: { score: 4, justification: 'j', proposed: [], status: 'generated', evidence: [] } }, 'new')
    expect(mergeExtraction(existing, generated, defs).facets.rigor).toEqual({ score: 4, justification: 'j', proposed: [], status: 'generated', evidence: [] })
    // Without the current facet defs, a verified entry is kept as before (unrelated call sites stay unaffected).
    expect(mergeExtraction(existing, generated).facets.rigor).toEqual(mismatched)
  })

  it('countPending and summaryState ignore it', () => {
    const e = sampleExtraction({ rigor: { ...mismatched, status: 'generated' } }, 'h')
    // Without the defs, the leftover `text` entry is counted as a pending facet; with them, it is treated as absent.
    expect(countPending(null, e, ['rigor'])).toBe(1)
    expect(countPending(null, e, ['rigor'], null, defs)).toBe(0)
    const reviewedSummary = verifyAll(sampleSummary(), null).summary!
    const base = { summary: reviewedSummary, extraction: e, formHash: 'h', thesisHash: null, textChars: 10, maxChars: 100, error: null }
    expect(summaryState({ ...base, facetKeys: ['rigor'], facetDefs: defs })).toBe('reviewed')
  })
})
