import type { JobRecord } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
import {
  SUMMARY_FIELD_KEYS,
  type Evidence,
  type ExtractionFile,
  type ExtractionForm,
  type FacetDef,
  type FacetEntry,
  type FieldStatus,
  type SummaryFieldKey,
  type SummaryFields,
  type SummaryFile,
  type ThesisContext,
  type ThesisRelation
} from '../../shared/summary'

export type CardStatus = 'generated' | 'verified' | 'edited' | 'evidence_missing'

/** A generated entry with a quote that was not found in the text needs a closer look. */
export function cardStatus(entry: { status: FieldStatus; evidence: Evidence[] }): CardStatus {
  if (entry.status === 'generated' && entry.evidence.some((e) => !e.found)) return 'evidence_missing'
  return entry.status
}

export type FieldCardData = { [K in SummaryFieldKey]: { key: K; entry: SummaryFields[K] } }[SummaryFieldKey]

export function summaryCards(summary: SummaryFile): FieldCardData[] {
  return SUMMARY_FIELD_KEYS.map((key) => ({ key, entry: summary.fields[key] }) as FieldCardData)
}

export function facetCards(form: ExtractionForm | null, extraction: ExtractionFile | null): { def: FacetDef; entry: FacetEntry | null }[] {
  if (!form) return []
  return form.facets.map((def) => ({ def, entry: extraction?.facets[def.key] ?? null }))
}

const NONE = '—'

export function facetValueText(def: FacetDef, entry: FacetEntry | null): string {
  if (!entry) return NONE
  switch (def.type) {
    case 'multi':
      return entry.values?.length ? entry.values.join(', ') : NONE
    case 'single':
      return entry.value || NONE
    case 'text':
      return entry.text?.trim() ? entry.text : NONE
    case 'scale':
      if (entry.score === undefined) return NONE
      return entry.justification?.trim() ? `${entry.score}/${def.max} — ${entry.justification}` : `${entry.score}/${def.max}`
  }
}

export type Availability = 'ready' | 'running' | 'no_text' | 'too_long'

/** Whether "Summarize" can run now; the main process requires indexed text (`text_status === 'ok'`). */
export function summarizeAvailability(detail: PaperDetail, jobs: JobRecord[]): Availability {
  const active = jobs.some(
    (j) => j.spec.type === 'summarize' && j.spec.paperId === detail.id && (j.state === 'queued' || j.state === 'running')
  )
  if (active) return 'running'
  if (detail.textStatus !== 'ok') return 'no_text'
  // With a summary the state is never too_long: a regeneration refused for the length shows up as its last error.
  if (detail.summaryStatus === 'too_long' || (detail.summary && detail.summaryError === 'too_long')) return 'too_long'
  return 'ready'
}

export type ThesisCardData =
  | { status: 'no_context' }
  | { status: 'ok'; relation: ThesisRelation | null; questions: ThesisContext['research_questions'] }

/** The "relation to the thesis" section; it needs a thesis title or description to exist. */
export function thesisCard(extraction: ExtractionFile | null, thesis: ThesisContext): ThesisCardData {
  if (!thesis.title.trim() && !thesis.description.trim()) return { status: 'no_context' }
  return { status: 'ok', relation: extraction?.thesis_relation ?? null, questions: thesis.research_questions }
}
