import { describe, expect, it } from 'vitest'
import { FacetSuggestionSchema, FacetSuggestionsFileSchema, isSuggestionName, SUGGESTION_ID, suggestionId } from '../../src/shared/facetSuggestions'
import { aliasSuggestion, newFacetSuggestion, newValueSuggestion } from '../helpers/facets'

describe('suggestion ids', () => {
  it('name the kind and what it changes', () => {
    expect(suggestionId({ kind: 'new_facet', facet: { key: 'data_source' } })).toBe('new_facet__data_source')
    expect(suggestionId({ kind: 'new_value', facet: 'data_type', value: 'metrics' })).toBe('new_value__data_type__metrics')
    expect(suggestionId({ kind: 'alias', facet: 'sanitization_technique', to: 'rules_regex' })).toBe('alias__sanitization_technique__rules_regex')
    for (const id of ['new_facet__data_source', 'new_value__data_type__metrics', 'alias__task__log_parsing']) expect(SUGGESTION_ID.test(id)).toBe(true)
    for (const id of ['', 'new_facet__', 'other__x', 'new_value__data_type', 'new_facet__Data']) expect(SUGGESTION_ID.test(id)).toBe(false)
  })

  it('accepts only snake_case names without a double underscore as suggested keys and values', () => {
    expect(isSuggestionName('public_dataset')).toBe(true)
    for (const v of ['Public', 'a__b', '_x', '1x', '']) expect(isSuggestionName(v)).toBe(false)
  })
})

describe('FacetSuggestionsFileSchema', () => {
  it('reads one suggestion of each kind and keeps keys a later version adds', () => {
    const file = FacetSuggestionsFileSchema.parse({
      schema_version: 1,
      suggestions: [newFacetSuggestion(), newValueSuggestion(), aliasSuggestion({ later: true })],
      last_run: { at: '2026-10-11T00:00:00.000Z', ok: true, summarized: 4 },
      later_key: 1
    })
    expect(file.suggestions.map((s) => s.kind)).toEqual(['new_facet', 'new_value', 'alias'])
    expect(file).toMatchObject({ later_key: 1, last_run: { ok: true, summarized: 4 } })
    expect(file.suggestions[2]).toMatchObject({ later: true })
  })

  it('refuses an id that does not match, an invalid facet, an empty alias source and another schema version', () => {
    expect(FacetSuggestionSchema.safeParse(newFacetSuggestion({ id: 'new_facet__other' })).success).toBe(false)
    expect(FacetSuggestionSchema.safeParse(newFacetSuggestion({ facet: { key: 'rigor_two', type: 'scale', description: 'd', min: 5, max: 1 } })).success).toBe(false)
    expect(FacetSuggestionSchema.safeParse(aliasSuggestion({ from: [] })).success).toBe(false)
    expect(FacetSuggestionsFileSchema.safeParse({ schema_version: 2, suggestions: [] }).success).toBe(false)
  })

  it('lets a decided suggestion keep its original id after an edit, but only of its own kind and facet', () => {
    const edited = newFacetSuggestion({ id: 'new_facet__data_source', facet: { key: 'data_origin', type: 'text', description: 'd' } })
    expect(FacetSuggestionSchema.safeParse(edited).success).toBe(false)
    expect(FacetSuggestionSchema.safeParse({ ...edited, status: 'accepted' }).success).toBe(true)
    expect(FacetSuggestionSchema.safeParse(newValueSuggestion({ id: 'new_value__data_type__metrics', value: 'x', status: 'rejected' })).success).toBe(true)
    expect(FacetSuggestionSchema.safeParse(newValueSuggestion({ id: 'new_value__task__metrics', status: 'accepted' })).success).toBe(false)
    expect(FacetSuggestionSchema.safeParse(aliasSuggestion({ id: 'new_value__sanitization_technique__x', status: 'accepted' })).success).toBe(false)
  })
})
