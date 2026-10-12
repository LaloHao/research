import type { FacetSuggestion, FacetSuggestionsFile } from '../../shared/facetSuggestions'

export const FACET_SUGGESTIONS_FILE = 'facet-suggestions.yaml'
export const EMPTY_FACET_SUGGESTIONS: FacetSuggestionsFile = { schema_version: 1, suggestions: [] }

/** Always written sorted by id, so two machines' changes merge entry by entry. */
export function sortSuggestions(list: FacetSuggestion[]): FacetSuggestion[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
