import { isSuggestionName, type FacetSuggestion, type FacetSuggestionsFile, type SuggestionEdit, type SuggestionValidity } from '../../shared/facetSuggestions'
import { FacetDefSchema, type ExtractionFile, type ExtractionForm, type FacetDef, type FacetEntry } from '../../shared/summary'
import { addAlias, addFacetValue, entryFitsFacet, InvalidEdit } from '../summary/merge'
import type { FacetOverview } from './facetOverview'

/** A new run replaces only the suggestions still waiting for review; a decided id is never brought back. */
export function replaceUnreviewed(file: FacetSuggestionsFile, fresh: FacetSuggestion[]): FacetSuggestionsFile {
  const kept = file.suggestions.filter((s) => s.status !== 'suggested')
  const decided = new Set(kept.map((s) => s.id))
  return { ...file, suggestions: [...kept, ...fresh.filter((s) => !decided.has(s.id))] }
}

function choiceFacet(form: ExtractionForm, key: string): { def: FacetDef | undefined; values: string[] | null } {
  const def = form.facets.find((f) => f.key === key)
  return { def, values: def && 'values' in def ? def.values : null }
}

/** Whether accepting `s` as it is still makes sense with the current form and the proposals papers hold now. */
export function suggestionValidity(s: FacetSuggestion, form: ExtractionForm, overview: FacetOverview): SuggestionValidity {
  if (s.kind === 'new_facet') return form.facets.some((f) => f.key === s.facet.key) ? 'facet_exists' : 'ok'
  const { def, values } = choiceFacet(form, s.facet)
  if (!def) return 'facet_missing'
  if (!values) return 'not_a_choice'
  if (s.kind === 'new_value') return values.includes(s.value) ? 'value_exists' : 'ok'
  const proposed = new Set(overview.facets.find((u) => u.key === s.facet)?.proposed.map((p) => p.value) ?? [])
  return s.from.some((v) => proposed.has(v)) ? 'ok' : 'source_gone'
}

/** «Editar y aceptar»: the user's version of the proposal; the id stays, so the suggestion is still the same one. */
export function withEdit(s: FacetSuggestion, edit: SuggestionEdit | undefined): FacetSuggestion {
  if (!edit) return s
  if (edit.kind === 'new_facet' && s.kind === 'new_facet') {
    const values = 'values' in edit.facet ? { values: [...new Set(edit.facet.values)] } : {}
    const parsed = FacetDefSchema.safeParse({ ...edit.facet, ...values })
    if (!parsed.success || !isSuggestionName(parsed.data.key) || ('values' in parsed.data && parsed.data.values.some((v) => !isSuggestionName(v)))) {
      throw new InvalidEdit('Invalid facet')
    }
    return { ...s, facet: parsed.data }
  }
  if (edit.kind === 'new_value' && s.kind === 'new_value') {
    if (!isSuggestionName(edit.value)) throw new InvalidEdit('Invalid value')
    return { ...s, value: edit.value }
  }
  if (edit.kind === 'alias' && s.kind === 'alias') {
    if (!isSuggestionName(edit.to) || s.from.includes(edit.to)) throw new InvalidEdit('Invalid alias target')
    return { ...s, to: edit.to }
  }
  throw new InvalidEdit('The edit does not match the suggestion')
}

/**
 * A proposal still waiting for review takes the value it now maps to: `to` joins a multi facet's values, or becomes a
 * single facet's value when it has none. Verified and edited entries, and entries of another type, are never touched.
 */
export function reassignProposals(e: ExtractionFile, def: FacetDef, from: string[], to: string): ExtractionFile | null {
  const current = e.facets[def.key]
  if (!current || current.status !== 'generated' || !entryFitsFacet(def, current)) return null
  if (!current.proposed.some((p) => from.includes(p))) return null
  const proposed = current.proposed.filter((p) => !from.includes(p))
  const next: FacetEntry =
    def.type === 'multi'
      ? { ...current, proposed, values: (current.values ?? []).includes(to) ? current.values : [...(current.values ?? []), to] }
      : { ...current, proposed, value: current.value ?? to }
  return { ...e, facets: { ...e.facets, [def.key]: next } }
}

export interface Acceptance {
  /** The form to save. */
  form: ExtractionForm
  /** What changes in each paper's classification (null: no paper changes). */
  rewrite: ((e: ExtractionFile) => ExtractionFile | null) | null
}

/** What accepting `s` (already checked with suggestionValidity) does to the form and to the papers. */
export function acceptance(s: FacetSuggestion, form: ExtractionForm): Acceptance {
  switch (s.kind) {
    case 'new_facet':
      return { form: { ...form, facets: [...form.facets, s.facet] }, rewrite: null }
    case 'new_value': {
      const next = addFacetValue(form, s.facet, s.value)
      const def = next.facets.find((f) => f.key === s.facet)!
      return { form: next, rewrite: (e) => reassignProposals(e, def, [s.value], s.value) }
    }
    case 'alias': {
      let next = addFacetValue(form, s.facet, s.to)
      for (const from of s.from) next = addAlias(next, s.facet, from, s.to)
      const def = next.facets.find((f) => f.key === s.facet)!
      return { form: next, rewrite: (e) => reassignProposals(e, def, s.from, s.to) }
    }
  }
}
