import { FACET_KEY_PATTERN, type ExtractionForm, type FacetDef } from '../../shared/summary'

/** Why one field of a draft extraction form is not ready to save; each has a message under `settings.form_editor.issues`. */
export const DRAFT_ISSUE_CODES = [
  'key_format',
  'key_duplicate',
  'required',
  'values_required',
  'value_format',
  'value_duplicate',
  'scale_order',
  'not_integer'
] as const
export type DraftIssue = (typeof DRAFT_ISSUE_CODES)[number]

function hasValues(facet: FacetDef): facet is FacetDef & { values: string[] } {
  return facet.type === 'single' || facet.type === 'multi'
}

export function addFacet(draft: ExtractionForm, facet: FacetDef): ExtractionForm {
  return { ...draft, facets: [...draft.facets, facet] }
}

/** Drops the facet and any learned aliases recorded under its key. */
export function removeFacet(draft: ExtractionForm, key: string): ExtractionForm {
  const { [key]: _dropped, ...value_aliases } = draft.value_aliases
  return { facets: draft.facets.filter((f) => f.key !== key), value_aliases }
}

export function updateFacet(draft: ExtractionForm, key: string, patch: Partial<FacetDef>): ExtractionForm {
  return { ...draft, facets: draft.facets.map((f) => (f.key === key ? ({ ...f, ...patch } as FacetDef) : f)) }
}

export function addValue(draft: ExtractionForm, facetKey: string, value: string): ExtractionForm {
  return {
    ...draft,
    facets: draft.facets.map((f) => (f.key === facetKey && hasValues(f) ? { ...f, values: [...f.values, value] } : f))
  }
}

/** Removes the value from its facet and drops any learned alias that pointed to it. */
export function removeValue(draft: ExtractionForm, facetKey: string, value: string): ExtractionForm {
  const facets = draft.facets.map((f) => (f.key === facetKey && hasValues(f) ? { ...f, values: f.values.filter((v) => v !== value) } : f))
  const aliasesForFacet = draft.value_aliases[facetKey]
  if (!aliasesForFacet) return { ...draft, facets }
  const kept = Object.fromEntries(Object.entries(aliasesForFacet).filter(([, to]) => to !== value))
  const value_aliases = { ...draft.value_aliases }
  if (Object.keys(kept).length) value_aliases[facetKey] = kept
  else delete value_aliases[facetKey]
  return { facets, value_aliases }
}

/** Removes one learned alias (`proposed` -> allowed value) from a facet. */
export function removeAlias(draft: ExtractionForm, facetKey: string, proposed: string): ExtractionForm {
  const aliasesForFacet = draft.value_aliases[facetKey]
  if (!aliasesForFacet) return draft
  const { [proposed]: _dropped, ...kept } = aliasesForFacet
  const value_aliases = { ...draft.value_aliases }
  if (Object.keys(kept).length) value_aliases[facetKey] = kept
  else delete value_aliases[facetKey]
  return { ...draft, value_aliases }
}

/** Normalizes object key order so unrelated edits (e.g. rebuilding value_aliases) don't register as a difference. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    }
    return v
  })
}

export function isDirty(saved: ExtractionForm, draft: ExtractionForm): boolean {
  return sortedJson(saved) !== sortedJson(draft)
}

/** Validates a draft form client-side, the same checks `loadForm` applies on the main side. */
export function validateDraft(draft: ExtractionForm): Record<string, DraftIssue> {
  const issues: Record<string, DraftIssue> = {}
  const keyCounts = new Map<string, number>()
  for (const f of draft.facets) keyCounts.set(f.key, (keyCounts.get(f.key) ?? 0) + 1)

  draft.facets.forEach((facet, i) => {
    if (facet.key.trim() === '') issues[`facets.${i}.key`] = 'required'
    else if (!FACET_KEY_PATTERN.test(facet.key)) issues[`facets.${i}.key`] = 'key_format'
    else if ((keyCounts.get(facet.key) ?? 0) > 1) issues[`facets.${i}.key`] = 'key_duplicate'

    if (facet.description.trim() === '') issues[`facets.${i}.description`] = 'required'

    if (hasValues(facet)) {
      if (facet.values.length === 0) issues[`facets.${i}.values`] = 'values_required'
      else {
        const seen = new Set<string>()
        let bad: DraftIssue | undefined
        for (const v of facet.values) {
          if (!FACET_KEY_PATTERN.test(v)) bad ??= 'value_format'
          else if (seen.has(v)) bad ??= 'value_duplicate'
          seen.add(v)
        }
        if (bad) issues[`facets.${i}.values`] = bad
      }
    }

    if (facet.type === 'scale') {
      const minOk = Number.isInteger(facet.min)
      const maxOk = Number.isInteger(facet.max)
      if (!minOk) issues[`facets.${i}.min`] = 'not_integer'
      if (!maxOk) issues[`facets.${i}.max`] = 'not_integer'
      if (minOk && maxOk && facet.min > facet.max) issues[`facets.${i}.max`] = 'scale_order'
    }
  })

  return issues
}

/** Validates one value being typed into a facet's "add value" input, before it is committed with `addValue`. */
export function validateNewValue(existing: string[], candidate: string): DraftIssue | undefined {
  if (candidate.trim() === '') return 'required'
  if (!FACET_KEY_PATTERN.test(candidate)) return 'value_format'
  if (existing.includes(candidate)) return 'value_duplicate'
  return undefined
}
