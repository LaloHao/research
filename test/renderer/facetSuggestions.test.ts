import { describe, expect, it } from 'vitest'
import { canAccept, editFor, editIssues, facetChoices, groupSuggestions, retypeFacet, splitValues } from '../../src/renderer/lib/facetSuggestions'
import type { FacetSuggestionList } from '../../src/shared/facetSuggestions'
import type { ExtractionForm } from '../../src/shared/summary'
import { aliasSuggestion, newFacetSuggestion, newValueSuggestion } from '../helpers/facets'

const FORM: ExtractionForm = {
  facets: [
    { key: 'data_type', type: 'multi', description: 'd', values: ['logs', 'traces'] },
    { key: 'rigor', type: 'scale', description: 'r', min: 1, max: 5 }
  ],
  value_aliases: {}
}

const list = (suggestions: FacetSuggestionList['suggestions']): FacetSuggestionList => ({ file: { status: 'ok' }, suggestions, pending: 0, running: false, lastRun: null })

describe('facet suggestions view', () => {
  it('groups suggestions by status, new facets first', () => {
    const groups = groupSuggestions(
      list([
        { suggestion: aliasSuggestion(), validity: 'ok' },
        { suggestion: newValueSuggestion({ status: 'rejected' }), validity: 'ok' },
        { suggestion: newFacetSuggestion(), validity: 'facet_exists' },
        { suggestion: newValueSuggestion({ value: 'chat_logs', status: 'accepted' }), validity: 'value_exists' }
      ])
    )
    expect(groups.pending.map((v) => v.suggestion.kind)).toEqual(['new_facet', 'alias'])
    expect(groups.rejected.map((v) => v.suggestion.id)).toEqual(['new_value__data_type__metrics'])
    expect(groups.accepted.map((v) => v.suggestion.id)).toEqual(['new_value__data_type__chat_logs'])
    expect(groupSuggestions(null)).toEqual({ pending: [], accepted: [], rejected: [] })
  })

  it('lets a suggestion be accepted only while it applies and the form has no unsaved changes', () => {
    expect(canAccept({ suggestion: newFacetSuggestion(), validity: 'ok' }, false)).toBe(true)
    expect(canAccept({ suggestion: newFacetSuggestion(), validity: 'ok' }, true)).toBe(false)
    expect(canAccept({ suggestion: newFacetSuggestion(), validity: 'facet_exists' }, false)).toBe(false)
    expect(canAccept({ suggestion: newFacetSuggestion({ status: 'rejected' }), validity: 'ok' }, false)).toBe(false)
  })

  it('starts an edit from the proposal and checks it with the form editor rules', () => {
    expect(editFor(newValueSuggestion())).toEqual({ kind: 'new_value', value: 'metrics' })
    expect(editFor(aliasSuggestion())).toEqual({ kind: 'alias', to: 'rules_regex' })
    const facet = editFor(newFacetSuggestion())
    expect(facet).toEqual({ kind: 'new_facet', facet: newFacetSuggestion().facet })
    expect(editIssues(facet, newFacetSuggestion(), FORM)).toEqual({})
    expect(editIssues({ kind: 'new_facet', facet: { key: 'data_type', type: 'text', description: '' } }, newFacetSuggestion(), FORM)).toEqual({
      key: 'key_duplicate',
      description: 'required'
    })
    expect(editIssues({ kind: 'new_facet', facet: { key: 'data__src', type: 'multi', description: 'd', values: [] } }, newFacetSuggestion(), FORM)).toEqual({
      key: 'key_format',
      values: 'values_required'
    })
    expect(editIssues({ kind: 'new_facet', facet: { key: 'maturity', type: 'scale', description: 'd', min: 4, max: 2 } }, newFacetSuggestion(), FORM)).toEqual({ max: 'scale_order' })
    expect(editIssues({ kind: 'new_value', value: 'logs' }, newValueSuggestion(), FORM)).toEqual({ value: 'value_duplicate' })
    expect(editIssues({ kind: 'new_value', value: 'a__b' }, newValueSuggestion(), FORM)).toEqual({ value: 'value_format' })
    expect(editIssues({ kind: 'new_value', value: 'system_metrics' }, newValueSuggestion(), FORM)).toEqual({})
    expect(editIssues({ kind: 'alias', to: 'Regex' }, aliasSuggestion(), FORM)).toEqual({ to: 'value_format' })
    expect(editIssues({ kind: 'alias', to: 'regex_rules' }, aliasSuggestion(), FORM)).toEqual({ to: 'value_duplicate' })
  })

  it('summarizes, retypes and reads facet values', () => {
    expect(facetChoices({ key: 'a', type: 'multi', description: 'd', values: ['x', 'y'] })).toBe('x, y')
    expect(facetChoices({ key: 'a', type: 'scale', description: 'd', min: 1, max: 5 })).toBe('1–5')
    expect(facetChoices({ key: 'a', type: 'text', description: 'd' })).toBe('')
    expect(retypeFacet({ key: 'a', type: 'multi', description: 'd', values: ['x'] }, 'single')).toEqual({ key: 'a', type: 'single', description: 'd', values: ['x'] })
    expect(retypeFacet({ key: 'a', type: 'multi', description: 'd', values: ['x'] }, 'scale')).toEqual({ key: 'a', type: 'scale', description: 'd', min: 1, max: 5 })
    expect(retypeFacet({ key: 'a', type: 'scale', description: 'd', min: 1, max: 5 }, 'multi')).toEqual({ key: 'a', type: 'multi', description: 'd', values: [] })
    expect(retypeFacet({ key: 'a', type: 'single', description: 'd', values: ['x'] }, 'text')).toEqual({ key: 'a', type: 'text', description: 'd' })
    expect(splitValues(' a, b ,, c ')).toEqual(['a', 'b', 'c'])
  })
})
