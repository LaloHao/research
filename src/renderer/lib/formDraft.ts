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

/**
 * One facet being edited, with a stable id that never changes for the life of the editing session — unlike its
 * `key`, which the user can retype while the facet is new. Actions and validation issues address a facet by this
 * id instead of its key, so renaming a facet never merges it with another or loses focus mid-keystroke.
 */
export interface DraftFacet {
  id: string
  facet: FacetDef
}

/** The draft form being edited: `ExtractionForm.facets` with a stable id attached to each entry. */
export interface FormDraft {
  facets: DraftFacet[]
  value_aliases: ExtractionForm['value_aliases']
}

function hasValues(facet: FacetDef): facet is FacetDef & { values: string[] } {
  return facet.type === 'single' || facet.type === 'multi'
}

/** Starts a draft from a saved form, assigning every facet a fresh id. */
export function draftFromForm(form: ExtractionForm): FormDraft {
  return { facets: form.facets.map((facet) => ({ id: crypto.randomUUID(), facet })), value_aliases: form.value_aliases }
}

/**
 * The saved form loaded again (it changed on disk): a facet whose key is still there keeps its id, so input typed for
 * it and keyed by id (a value not added yet, a bound not committed) survives the reload; other facets get a fresh id.
 */
export function rebaseDraft(previous: FormDraft, saved: ExtractionForm): FormDraft {
  const ids = new Map(previous.facets.map((f) => [f.facet.key, f.id]))
  return { facets: saved.facets.map((facet) => ({ id: ids.get(facet.key) ?? crypto.randomUUID(), facet })), value_aliases: saved.value_aliases }
}

/**
 * Input typed in the editor that is not in the draft yet, so it doesn't make the draft dirty but would be lost by
 * rewriting the saved form: a value typed but not added, a scale bound typed but not committed (or invalid), or a new
 * facet being filled in. Input left for facets no longer in the draft doesn't count.
 */
export function hasPendingInput(draft: FormDraft, newValueText: Record<string, string>, scaleText: Record<string, string>, addingFacet: boolean): boolean {
  if (addingFacet) return true
  return draft.facets.some(({ id, facet }) => {
    if ((newValueText[id] ?? '').trim() !== '') return true
    if (facet.type !== 'scale') return false
    return (['min', 'max'] as const).some((field) => {
      const text = scaleText[`${id}.${field}`]
      return text !== undefined && text.trim() !== String(facet[field])
    })
  })
}

/** The plain `ExtractionForm` a draft represents, dropping the local-only ids. */
export function formFromDraft(draft: FormDraft): ExtractionForm {
  return { facets: draft.facets.map((d) => d.facet), value_aliases: draft.value_aliases }
}

export function addFacet(draft: FormDraft, facet: FacetDef, id: string = crypto.randomUUID()): FormDraft {
  return { ...draft, facets: [...draft.facets, { id, facet }] }
}

/** Replaces a facet's definition outright (e.g. switching its type), keeping its id. */
export function replaceFacet(draft: FormDraft, id: string, facet: FacetDef): FormDraft {
  return { ...draft, facets: draft.facets.map((f) => (f.id === id ? { id, facet } : f)) }
}

/** Drops the facet and any learned aliases recorded under its (current) key. */
export function removeFacet(draft: FormDraft, id: string): FormDraft {
  const target = draft.facets.find((f) => f.id === id)
  const facets = draft.facets.filter((f) => f.id !== id)
  if (!target) return { ...draft, facets }
  const { [target.facet.key]: _dropped, ...value_aliases } = draft.value_aliases
  return { facets, value_aliases }
}

export function updateFacet(draft: FormDraft, id: string, patch: Partial<FacetDef>): FormDraft {
  return { ...draft, facets: draft.facets.map((f) => (f.id === id ? { id, facet: { ...f.facet, ...patch } as FacetDef } : f)) }
}

export function addValue(draft: FormDraft, id: string, value: string): FormDraft {
  return {
    ...draft,
    facets: draft.facets.map((f) => (f.id === id && hasValues(f.facet) ? { id, facet: { ...f.facet, values: [...f.facet.values, value] } } : f))
  }
}

/** Removes the value from its facet and drops any learned alias (keyed by the facet's current key) that pointed to it. */
export function removeValue(draft: FormDraft, id: string, value: string): FormDraft {
  const target = draft.facets.find((f) => f.id === id)
  const facets = draft.facets.map((f) =>
    f.id === id && hasValues(f.facet) ? { id, facet: { ...f.facet, values: f.facet.values.filter((v) => v !== value) } } : f
  )
  if (!target) return { ...draft, facets }
  const aliasesForFacet = draft.value_aliases[target.facet.key]
  if (!aliasesForFacet) return { ...draft, facets }
  const kept = Object.fromEntries(Object.entries(aliasesForFacet).filter(([, to]) => to !== value))
  const value_aliases = { ...draft.value_aliases }
  if (Object.keys(kept).length) value_aliases[target.facet.key] = kept
  else delete value_aliases[target.facet.key]
  return { facets, value_aliases }
}

/** Removes one learned alias (`proposed` -> allowed value) from the facet currently at this key. */
export function removeAlias(draft: FormDraft, facetKey: string, proposed: string): FormDraft {
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

export function isDirty(saved: ExtractionForm, draft: FormDraft): boolean {
  return sortedJson(saved) !== sortedJson(formFromDraft(draft))
}

/**
 * Validates a draft form client-side, the same checks `loadForm` applies on the main side. Issues are keyed by a
 * facet's stable id (`facets.<id>.key|description|values|min|max`) rather than its array index, so they keep
 * pointing at the right field as facets are added, removed or reordered.
 */
export function validateDraft(draft: FormDraft): Record<string, DraftIssue> {
  const issues: Record<string, DraftIssue> = {}
  const keyCounts = new Map<string, number>()
  for (const { facet } of draft.facets) keyCounts.set(facet.key, (keyCounts.get(facet.key) ?? 0) + 1)

  for (const { id, facet } of draft.facets) {
    if (facet.key.trim() === '') issues[`facets.${id}.key`] = 'required'
    else if (!FACET_KEY_PATTERN.test(facet.key)) issues[`facets.${id}.key`] = 'key_format'
    else if ((keyCounts.get(facet.key) ?? 0) > 1) issues[`facets.${id}.key`] = 'key_duplicate'

    if (facet.description.trim() === '') issues[`facets.${id}.description`] = 'required'

    if (hasValues(facet)) {
      if (facet.values.length === 0) issues[`facets.${id}.values`] = 'values_required'
      else {
        const seen = new Set<string>()
        let bad: DraftIssue | undefined
        for (const v of facet.values) {
          if (!FACET_KEY_PATTERN.test(v)) bad ??= 'value_format'
          else if (seen.has(v)) bad ??= 'value_duplicate'
          seen.add(v)
        }
        if (bad) issues[`facets.${id}.values`] = bad
      }
    }

    if (facet.type === 'scale') {
      const minOk = Number.isInteger(facet.min)
      const maxOk = Number.isInteger(facet.max)
      if (!minOk) issues[`facets.${id}.min`] = 'not_integer'
      if (!maxOk) issues[`facets.${id}.max`] = 'not_integer'
      if (minOk && maxOk && facet.min > facet.max) issues[`facets.${id}.max`] = 'scale_order'
    }
  }

  return issues
}

/** Validates one value being typed into a facet's "add value" input, before it is committed with `addValue`. */
export function validateNewValue(existing: string[], candidate: string): DraftIssue | undefined {
  if (candidate.trim() === '') return 'required'
  if (!FACET_KEY_PATTERN.test(candidate)) return 'value_format'
  if (existing.includes(candidate)) return 'value_duplicate'
  return undefined
}
