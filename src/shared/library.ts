import type { CitationsStatus } from './relations'
import type { Paper } from './schemas'
import type { ExtractionFile, ExtractionForm, SummaryFile, SummaryStatus } from './summary'

export const TEXT_STATUSES = ['pending', 'ok', 'no_text', 'no_source', 'error'] as const
export type TextStatus = (typeof TEXT_STATUSES)[number]

/** One library list entry, as indexed in the cache. */
export interface PaperRow {
  id: string
  title: string
  authors_label: string
  year: number | null
  venue: string | null
  kind: string | null
  doi: string | null
  arxiv: string | null
  metadata_status: string | null
  has_pdf: boolean
  /** `<kind>: <message>` when paper.yaml cannot be read. */
  problem: string | null
  added_at: string | null
  text_status: TextStatus
  summary_status: SummaryStatus
  /** Fields and facets still `generated` (not yet verified or edited). */
  pending_review: number
  /** `generated.model` of the last summary, or `null` when there is none. */
  summary_model: string | null
  /** Whether citations were fetched from OpenAlex ('none' until the first try). */
  citations_status: CitationsStatus
  /** Suggested typed relations (not yet confirmed or rejected) that involve this paper. */
  relations_pending: number
}

/** Error codes the main process hands to the UI; each has a translation under `errors.<code>`. */
export const USER_ERROR_CODES = [
  'invalid_identifier',
  'not_found',
  'network',
  'unreadable_page',
  'not_a_pdf',
  'file_problem',
  'no_identifier',
  'conflict',
  'project_exists',
  'not_a_project',
  'invalid_project',
  'unreadable_pdf',
  'llm_unavailable',
  'llm_quota',
  'llm_invalid_output',
  'llm_timeout',
  'budget_exceeded',
  'no_text',
  'too_long',
  'invalid_form',
  'invalid_edit',
  'openalex_limit',
  'model_missing',
  'model_error',
  'operation_budget',
  'agent_tools_unavailable',
  'relations_conflict',
  'pdf_exists',
  'file_too_large',
  'paper_exists',
  'trash_problem',
  'folder_busy',
  'not_in_trash',
  'suggestion_outdated',
  'facet_suggestions_conflict',
  'summary_outdated',
  'unknown'
] as const
export type UserErrorCode = (typeof USER_ERROR_CODES)[number]

/** Why a paper.yaml cannot be read; each has a translation under `paper.problem_kinds.<kind>`. */
export const FILE_PROBLEM_KINDS = ['conflict_markers', 'invalid_yaml', 'invalid_schema'] as const
export type FileProblemKind = (typeof FILE_PROBLEM_KINDS)[number]

export const INGEST_STATUSES = ['added', 'merged', 'duplicate'] as const
export type IngestStatus = (typeof INGEST_STATUSES)[number]

/** What a finished job reports in `message`; each has a translation under `jobs.outcome.<value>`. */
export const JOB_OUTCOMES = [
  ...INGEST_STATUSES,
  'pdf_attached',
  'summarized',
  'citations_updated',
  'citations_unresolved',
  'cited_by_updated',
  'embedded',
  'model_downloaded',
  'relations_suggested',
  'relations_no_candidates',
  'facets_suggested',
  'facets_filled',
  'facets_nothing_to_fill'
] as const

export interface PaperDetail {
  id: string
  paper: Paper | null
  problem: string | null
  problemKind: FileProblemKind | null
  /** A local PDF exists, or one can be downloaded on demand. */
  hasPdf: boolean
  textStatus: TextStatus
  /** Readable text of a web page, when the paper is grey literature. */
  content: string | null
  summary: SummaryFile | null
  extraction: ExtractionFile | null
  /** The project's extraction form, when it is valid. */
  form: ExtractionForm | null
  summaryStatus: SummaryStatus
  /** Error code of the last failed summary, if any. */
  summaryError: string | null
  /** The relation to the thesis was reviewed against an earlier version of the thesis. */
  thesisOutdated: boolean
}
