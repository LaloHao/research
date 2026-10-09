import { z } from 'zod'
import {
  SUMMARY_FIELD_KEYS,
  SummaryFieldsSchema,
  type ExtractionFile,
  type ExtractionForm,
  type FacetEntry,
  type SummaryFieldKey,
  type SummaryFile,
  type SummaryStatus
} from '../../shared/summary'

export class InvalidEdit extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEdit'
  }
}

export type FacetPatch = { value?: string | null; values?: string[]; text?: string; score?: number; justification?: string }

export function mergeSummary(existing: SummaryFile | null, generated: SummaryFile): SummaryFile {
  if (!existing) return generated
  const fields = { ...generated.fields } as Record<SummaryFieldKey, unknown>
  for (const k of SUMMARY_FIELD_KEYS) if (existing.fields[k].status !== 'generated') fields[k] = existing.fields[k]
  return { ...existing, generated: generated.generated, fields: fields as SummaryFile['fields'] }
}

export function mergeExtraction(existing: ExtractionFile | null, generated: ExtractionFile): ExtractionFile {
  if (!existing) return generated
  const facets = { ...existing.facets }
  for (const [k, entry] of Object.entries(generated.facets)) {
    const old = existing.facets[k]
    if (!old || old.status === 'generated') facets[k] = entry
  }
  return { ...existing, form_hash: generated.form_hash, facets }
}

/** `generated` is only reachable from `verified`: an edited value stays the user's. */
function nextStatus(current: FacetEntry['status'], wanted: 'verified' | 'generated'): FacetEntry['status'] {
  if (wanted === 'verified') return 'verified'
  return current === 'verified' ? 'generated' : current
}

export function setFieldStatus(summary: SummaryFile, key: SummaryFieldKey, status: 'verified' | 'generated'): SummaryFile {
  const field = summary.fields[key]
  return { ...summary, fields: { ...summary.fields, [key]: { ...field, status: nextStatus(field.status, status) } } }
}

export function setFacetStatus(extraction: ExtractionFile, key: string, status: 'verified' | 'generated'): ExtractionFile {
  const facet = extraction.facets[key]
  if (!facet) throw new InvalidEdit(`Unknown facet ${key}`)
  return { ...extraction, facets: { ...extraction.facets, [key]: { ...facet, status: nextStatus(facet.status, status) } } }
}

export function verifyAll(summary: SummaryFile | null, extraction: ExtractionFile | null): { summary: SummaryFile | null; extraction: ExtractionFile | null } {
  const s = summary && {
    ...summary,
    fields: Object.fromEntries(Object.entries(summary.fields).map(([k, f]) => [k, f.status === 'generated' ? { ...f, status: 'verified' } : f])) as SummaryFile['fields']
  }
  const e = extraction && {
    ...extraction,
    facets: Object.fromEntries(Object.entries(extraction.facets).map(([k, f]) => [k, f.status === 'generated' ? { ...f, status: 'verified' as const } : f]))
  }
  return { summary: s, extraction: e }
}

export function editField(summary: SummaryFile, key: SummaryFieldKey, value: unknown): SummaryFile {
  const schema = SummaryFieldsSchema.shape[key].shape.value as z.ZodType
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidEdit(`Invalid value for ${key}`)
  return { ...summary, fields: { ...summary.fields, [key]: { ...summary.fields[key], value: parsed.data, status: 'edited' } } }
}

export function editFacet(extraction: ExtractionFile, form: ExtractionForm, key: string, patch: FacetPatch): ExtractionFile {
  const def = form.facets.find((f) => f.key === key)
  const current = extraction.facets[key] ?? { proposed: [], status: 'generated' as const, evidence: [] }
  if (!def) throw new InvalidEdit(`Unknown facet ${key}`)
  let next: FacetEntry
  switch (def.type) {
    case 'single':
      if (patch.value !== null && (typeof patch.value !== 'string' || !def.values.includes(patch.value))) throw new InvalidEdit(`Invalid value for ${key}`)
      next = { ...current, value: patch.value }
      break
    case 'multi':
      if (!Array.isArray(patch.values) || patch.values.some((v) => !def.values.includes(v))) throw new InvalidEdit(`Invalid values for ${key}`)
      next = { ...current, values: [...new Set(patch.values)] }
      break
    case 'text':
      if (typeof patch.text !== 'string') throw new InvalidEdit(`Invalid text for ${key}`)
      next = { ...current, text: patch.text }
      break
    case 'scale':
      if (!Number.isInteger(patch.score) || patch.score! < def.min || patch.score! > def.max || typeof patch.justification !== 'string') {
        throw new InvalidEdit(`Invalid score for ${key}`)
      }
      next = { ...current, score: patch.score, justification: patch.justification }
      break
  }
  return { ...extraction, facets: { ...extraction.facets, [key]: { ...next, status: 'edited' } } }
}

function replaceProposal(extraction: ExtractionFile, facetKey: string, from: string, to: string): ExtractionFile | null {
  const facet = extraction.facets[facetKey]
  if (!facet || !facet.proposed.includes(from)) return null
  const proposed = facet.proposed.filter((p) => p !== from)
  const next: FacetEntry =
    facet.values !== undefined
      ? { ...facet, proposed, values: facet.values.includes(to) ? facet.values : [...facet.values, to] }
      : { ...facet, proposed, value: to }
  return { ...extraction, facets: { ...extraction.facets, [facetKey]: next } }
}

export const acceptProposed = (e: ExtractionFile, facetKey: string, value: string): ExtractionFile | null => replaceProposal(e, facetKey, value, value)
export const mapProposed = (e: ExtractionFile, facetKey: string, from: string, to: string): ExtractionFile | null => replaceProposal(e, facetKey, from, to)

export function addFacetValue(form: ExtractionForm, facetKey: string, value: string): ExtractionForm {
  return {
    ...form,
    facets: form.facets.map((f) => (f.key === facetKey && 'values' in f && !f.values.includes(value) ? { ...f, values: [...f.values, value] } : f))
  }
}

export function addAlias(form: ExtractionForm, facetKey: string, from: string, to: string): ExtractionForm {
  return { ...form, value_aliases: { ...form.value_aliases, [facetKey]: { ...(form.value_aliases[facetKey] ?? {}), [from]: to } } }
}

export function countPending(summary: SummaryFile | null, extraction: ExtractionFile | null): number {
  const fields = summary ? Object.values(summary.fields).filter((f) => f.status === 'generated').length : 0
  const facets = extraction ? Object.values(extraction.facets).filter((f) => f.status === 'generated').length : 0
  return fields + facets
}

export function summaryState(i: {
  summary: SummaryFile | null
  extraction: ExtractionFile | null
  formHash: string | null
  textChars: number
  maxChars: number
  error: string | null
}): SummaryStatus {
  if (i.error) return 'failed'
  if (!i.summary) return i.textChars > i.maxChars ? 'too_long' : 'none'
  if (i.formHash && i.extraction && i.extraction.form_hash !== i.formHash) return 'stale'
  return countPending(i.summary, i.extraction) > 0 ? 'generated' : 'reviewed'
}

export function summarySearchText(summary: SummaryFile | null, extraction: ExtractionFile | null): string {
  const parts: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (typeof v === 'number') parts.push(String(v))
    else if (Array.isArray(v)) v.forEach(add)
    else if (v && typeof v === 'object') Object.values(v).forEach(add)
  }
  if (summary) for (const f of Object.values(summary.fields)) add(f.value)
  if (extraction) for (const f of Object.values(extraction.facets)) add([f.value, f.values, f.text, f.justification, f.proposed])
  return parts.join(' ')
}
