import { describe, expect, it } from 'vitest'
import type { FacetOverview } from '../../../src/main/facets/facetOverview'
import { acceptance, reassignProposals, replaceUnreviewed, suggestionValidity, withEdit } from '../../../src/main/facets/facetSuggestionMerge'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { InvalidEdit } from '../../../src/main/summary/merge'
import type { ExtractionFile, FacetDef, FacetEntry } from '../../../src/shared/summary'
import { aliasSuggestion, newFacetSuggestion, newValueSuggestion } from '../../helpers/facets'

const FORM = DEFAULT_EXTRACTION_FORM
const overview = (proposed: string[] = ['regex_rules']): FacetOverview => ({
  papers: 1,
  facets: [{ key: 'sanitization_technique', type: 'multi', description: 'd', allowed: [], filled: 1, values: [], proposed: proposed.map((value) => ({ value, papers: ['a2020x'] })) }]
})
const entry = (over: Partial<FacetEntry>): FacetEntry => ({ proposed: [], status: 'generated', evidence: [], ...over })
const ext = (facets: ExtractionFile['facets']): ExtractionFile => ({ schema_version: 1, form_hash: 'h', facets })
const technique = FORM.facets.find((f) => f.key === 'sanitization_technique') as FacetDef & { values: string[] }
const llmUsage = FORM.facets.find((f) => f.key === 'llm_usage') as FacetDef

describe('replaceUnreviewed', () => {
  it('keeps what the user decided, drops the old unreviewed suggestions and never brings back a decided id', () => {
    const file = {
      schema_version: 1 as const,
      suggestions: [newFacetSuggestion({ status: 'accepted' }), newValueSuggestion({ status: 'rejected' }), aliasSuggestion(), newValueSuggestion({ value: 'tickets_old', id: undefined })],
      last_run: { at: '2026-10-10T00:00:00.000Z', ok: true, summarized: 1 }
    }
    const fresh = [newFacetSuggestion(), newValueSuggestion(), newValueSuggestion({ value: 'chat_logs' })]
    const next = replaceUnreviewed(file, fresh)
    expect(next.suggestions.map((s) => [s.id, s.status])).toEqual([
      ['new_facet__data_source', 'accepted'],
      ['new_value__data_type__metrics', 'rejected'],
      ['new_value__data_type__chat_logs', 'suggested']
    ])
    expect(next.last_run).toEqual(file.last_run)
  })
})

describe('suggestionValidity', () => {
  it('says why a suggestion no longer applies to the current form', () => {
    expect(suggestionValidity(newFacetSuggestion(), FORM, overview())).toBe('ok')
    expect(suggestionValidity(newFacetSuggestion({ facet: { key: 'rigor', type: 'text', description: 'd' } }), FORM, overview())).toBe('facet_exists')
    expect(suggestionValidity(newValueSuggestion(), FORM, overview())).toBe('ok')
    expect(suggestionValidity(newValueSuggestion({ value: 'logs' }), FORM, overview())).toBe('value_exists')
    expect(suggestionValidity(newValueSuggestion({ facet: 'gone' }), FORM, overview())).toBe('facet_missing')
    expect(suggestionValidity(newValueSuggestion({ facet: 'traceability' }), FORM, overview())).toBe('not_a_choice')
    expect(suggestionValidity(aliasSuggestion(), FORM, overview())).toBe('ok')
    expect(suggestionValidity(aliasSuggestion(), FORM, overview([]))).toBe('source_gone')
    expect(suggestionValidity(aliasSuggestion({ facet: 'traceability' }), FORM, overview())).toBe('not_a_choice')
  })
})

describe('withEdit', () => {
  it("replaces the proposal with the user's version, keeping the id", () => {
    const edited = withEdit(newFacetSuggestion(), { kind: 'new_facet', facet: { key: 'data_origin', type: 'single', description: 'Origin', values: ['public', 'public', 'private'] } })
    expect(edited).toMatchObject({ id: 'new_facet__data_source', facet: { key: 'data_origin', type: 'single', values: ['public', 'private'] } })
    expect(withEdit(newValueSuggestion(), { kind: 'new_value', value: 'system_metrics' })).toMatchObject({ id: 'new_value__data_type__metrics', value: 'system_metrics' })
    expect(withEdit(aliasSuggestion(), { kind: 'alias', to: 'regex' })).toMatchObject({ to: 'regex' })
    expect(withEdit(aliasSuggestion(), undefined)).toEqual(aliasSuggestion())
  })

  it('refuses an edit of another kind or an invalid proposal', () => {
    expect(() => withEdit(newValueSuggestion(), { kind: 'alias', to: 'x' })).toThrow(InvalidEdit)
    expect(() => withEdit(newValueSuggestion(), { kind: 'new_value', value: 'Bad Value' })).toThrow(InvalidEdit)
    expect(() => withEdit(newFacetSuggestion(), { kind: 'new_facet', facet: { key: 'x__y', type: 'text', description: 'd' } })).toThrow(InvalidEdit)
    expect(() => withEdit(newFacetSuggestion(), { kind: 'new_facet', facet: { key: 'scale_x', type: 'scale', description: 'd', min: 3, max: 1 } })).toThrow(InvalidEdit)
    expect(() => withEdit(aliasSuggestion(), { kind: 'alias', to: 'regex_rules' })).toThrow(InvalidEdit)
  })
})

describe('acceptance', () => {
  it('adds a new facet and rewrites no paper', () => {
    const a = acceptance(newFacetSuggestion(), FORM)
    expect(a.form.facets.map((f) => f.key)).toEqual([...FORM.facets.map((f) => f.key), 'data_source'])
    expect(a.rewrite).toBeNull()
  })

  it('adds a new value and moves that proposal into the values of entries still to review', () => {
    const a = acceptance(newValueSuggestion(), FORM)
    expect(a.form.facets.find((f) => f.key === 'data_type')).toMatchObject({ values: expect.arrayContaining(['metrics']) })
    expect(a.rewrite?.(ext({ data_type: entry({ values: ['logs'], proposed: ['metrics'] }) }))?.facets.data_type).toMatchObject({ values: ['logs', 'metrics'], proposed: [] })
    expect(a.rewrite?.(ext({ data_type: entry({ values: ['logs'], proposed: ['metrics'], status: 'edited' }) }))).toBeNull()
  })

  it('adds the aliases and the target value, and maps the sources in entries still to review', () => {
    const a = acceptance(aliasSuggestion({ from: ['regex_rules', 'regexes'], to: 'regex_masking' }), FORM)
    expect(a.form.value_aliases).toEqual({ sanitization_technique: { regex_rules: 'regex_masking', regexes: 'regex_masking' } })
    expect(a.form.facets.find((f) => f.key === 'sanitization_technique')).toMatchObject({ values: expect.arrayContaining(['regex_masking']) })
    expect(a.rewrite?.(ext({ sanitization_technique: entry({ values: ['ner'], proposed: ['regexes', 'llm_redaction'] }) }))?.facets.sanitization_technique).toMatchObject({
      values: ['ner', 'regex_masking'],
      proposed: ['llm_redaction']
    })
    expect(a.rewrite?.(ext({ sanitization_technique: entry({ values: ['ner'], proposed: ['regexes'], status: 'verified' }) }))).toBeNull()
  })
})

describe('reassignProposals', () => {
  it('sets a single facet only when it has no value, and leaves entries that do not propose a source alone', () => {
    expect(reassignProposals(ext({ llm_usage: entry({ value: null, proposed: ['api'] }) }), llmUsage, ['api'], 'cloud_api')?.facets.llm_usage).toMatchObject({ value: 'cloud_api', proposed: [] })
    expect(reassignProposals(ext({ llm_usage: entry({ value: 'local', proposed: ['api'] }) }), llmUsage, ['api'], 'cloud_api')?.facets.llm_usage).toMatchObject({ value: 'local', proposed: [] })
    expect(reassignProposals(ext({ llm_usage: entry({ value: 'local', proposed: ['other'] }) }), llmUsage, ['api'], 'cloud_api')).toBeNull()
    expect(reassignProposals(ext({}), technique, ['regexes'], 'rules_regex')).toBeNull()
    // An entry of another type (the facet was recreated) is a different facet: untouched.
    expect(reassignProposals(ext({ sanitization_technique: entry({ text: 'x', proposed: ['regexes'] }) }), technique, ['regexes'], 'rules_regex')).toBeNull()
  })
})
