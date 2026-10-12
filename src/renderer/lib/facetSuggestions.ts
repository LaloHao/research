import { isSuggestionName, type FacetSuggestion, type FacetSuggestionList, type FacetSuggestionView, type SuggestionEdit } from '../../shared/facetSuggestions'
import type { ExtractionForm, FacetDef } from '../../shared/summary'
import { validateDraft, validateNewValue, type DraftIssue, type FormDraft } from './formDraft'

const KIND_ORDER: Record<FacetSuggestion['kind'], number> = { new_facet: 0, new_value: 1, alias: 2 }

export interface SuggestionGroups {
  pending: FacetSuggestionView[]
  accepted: FacetSuggestionView[]
  rejected: FacetSuggestionView[]
}

const byKind = (a: FacetSuggestionView, b: FacetSuggestionView): number =>
  KIND_ORDER[a.suggestion.kind] - KIND_ORDER[b.suggestion.kind] || (a.suggestion.id < b.suggestion.id ? -1 : a.suggestion.id > b.suggestion.id ? 1 : 0)

/** The section's three lists: to review (shown), accepted and rejected (folded). */
export function groupSuggestions(list: FacetSuggestionList | null): SuggestionGroups {
  const views = [...(list?.suggestions ?? [])].sort(byKind)
  return {
    pending: views.filter((v) => v.suggestion.status === 'suggested'),
    accepted: views.filter((v) => v.suggestion.status === 'accepted'),
    rejected: views.filter((v) => v.suggestion.status === 'rejected')
  }
}

/** Accepting rewrites the saved form: only for a suggestion that still applies, and never over unsaved form edits. */
export function canAccept(view: FacetSuggestionView, formDirty: boolean): boolean {
  return view.suggestion.status === 'suggested' && view.validity === 'ok' && !formDirty
}

/** «Editar y aceptar» starts from the proposal as Claude made it. */
export function editFor(s: FacetSuggestion): SuggestionEdit {
  switch (s.kind) {
    case 'new_facet':
      return { kind: 'new_facet', facet: s.facet }
    case 'new_value':
      return { kind: 'new_value', value: s.value }
    case 'alias':
      return { kind: 'alias', to: s.to }
  }
}

const EDIT_ID = 'edit'

/** What is wrong with an edit, by field, with the form editor's own rules (a key or value with `__` is refused too). */
export function editIssues(edit: SuggestionEdit, s: FacetSuggestion, form: ExtractionForm): Record<string, DraftIssue> {
  if (edit.kind === 'new_facet') {
    const draft: FormDraft = { facets: [...form.facets.map((facet) => ({ id: `saved:${facet.key}`, facet })), { id: EDIT_ID, facet: edit.facet }], value_aliases: {} }
    const prefix = `facets.${EDIT_ID}.`
    const issues: Record<string, DraftIssue> = {}
    for (const [path, issue] of Object.entries(validateDraft(draft))) if (path.startsWith(prefix)) issues[path.slice(prefix.length)] = issue
    if (!issues.key && !isSuggestionName(edit.facet.key)) issues.key = 'key_format'
    if (!issues.values && 'values' in edit.facet && edit.facet.values.some((v) => !isSuggestionName(v))) issues.values = 'value_format'
    return issues
  }
  if (edit.kind === 'new_value') {
    const def = s.kind === 'new_value' ? form.facets.find((f) => f.key === s.facet) : undefined
    const existing = def && 'values' in def ? def.values : []
    const issue = validateNewValue(existing, edit.value) ?? (isSuggestionName(edit.value) ? undefined : 'value_format')
    return issue ? { value: issue } : {}
  }
  if (!isSuggestionName(edit.to)) return { to: 'value_format' }
  if (s.kind === 'alias' && s.from.includes(edit.to)) return { to: 'value_duplicate' }
  return {}
}

/** A facet's choices or range on one line: "a, b", "1–5", or '' for free text. */
export function facetChoices(def: FacetDef): string {
  if (def.type === 'scale') return `${def.min}–${def.max}`
  return 'values' in def ? def.values.join(', ') : ''
}

/** The facet as another type, keeping its key and description (and its values when both types have them). */
export function retypeFacet(def: FacetDef, type: FacetDef['type']): FacetDef {
  const base = { key: def.key, description: def.description }
  if (type === 'text') return { ...base, type: 'text' }
  if (type === 'scale') return { ...base, type: 'scale', min: 1, max: 5 }
  return { ...base, type, values: 'values' in def ? def.values : [] }
}

/** Values typed as a comma-separated list. */
export function splitValues(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}
