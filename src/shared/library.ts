import type { CitationsStatus } from './relations'
import type { Author, Paper } from './schemas'
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
  /** Facets of the current form the paper's (up-to-date) classification has no entry for yet: «Faceta nueva sin llenar». */
  unfilled_facets: number
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
  'chat_busy',
  'chat_not_found',
  'chat_invalid',
  'paper_not_in_library',
  'chat_message_budget',
  'approval_gone',
  'undo_unavailable',
  'draft_busy',
  'draft_not_found',
  'draft_invalid',
  'draft_budget',
  'mapping_not_found',
  'mapping_invalid',
  'import_unreadable',
  'criterion_required',
  'not_eligible',
  'nothing_to_snowball',
  'search_query_invalid',
  'search_query_separator',
  'search_query_quoted_wildcard',
  'search_not_completable',
  'search_too_large',
  'search_completion_pending',
  'request_rejected',
  'writing_file_unreadable',
  'writing_file_too_large',
  'capture_no_pdf',
  'outline_too_large',
  'cite_check_budget',
  'access_denied',
  'openalex_access_denied',
  'site_blocked',
  'rate_limited',
  'server_error',
  'unknown'
] as const
export type UserErrorCode = (typeof USER_ERROR_CODES)[number]

const KNOWN_CODES: ReadonlySet<string> = new Set(USER_ERROR_CODES)

/**
 * A code with what the failure itself said (e.g. OpenAlex's reason for refusing a search), as one string that travels
 * in a job's message and an `{ ok: false, error }`: `<code>: <detail>`. Without a detail it is just the code.
 */
export function userErrorMessage(code: UserErrorCode, detail?: string | null): string {
  const text = detail?.replace(/\s+/g, ' ').trim()
  return text ? `${code}: ${text}` : code
}

/** The code and detail of a `userErrorMessage`; null when the text is not one (a raw message). */
export function parseUserError(message: string): { code: UserErrorCode; detail: string | null } | null {
  if (KNOWN_CODES.has(message)) return { code: message as UserErrorCode, detail: null }
  const at = message.indexOf(': ')
  if (at <= 0 || !KNOWN_CODES.has(message.slice(0, at))) return null
  return { code: message.slice(0, at) as UserErrorCode, detail: message.slice(at + 2) }
}

/**
 * A job outcome with numbers for its wording, as one string a job's `message` can hold: `<outcome>: key=1,key=2`.
 * Without numbers it is just the outcome.
 */
export function outcomeMessage(outcome: (typeof JOB_OUTCOMES)[number], params: Record<string, number> = {}): string {
  const detail = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  return detail ? `${outcome}: ${detail}` : outcome
}

/** The outcome and numbers of an `outcomeMessage`; a plain message is an outcome without numbers. */
export function parseOutcome(message: string): { outcome: string; params: Record<string, number> } {
  const m = /^([a-z_]+): ((?:[a-z_]+=-?\d+)(?:,[a-z_]+=-?\d+)*)$/.exec(message)
  if (!m) return { outcome: message, params: {} }
  return { outcome: m[1], params: Object.fromEntries(m[2].split(',').map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])])) }
}

/** Why a paper.yaml cannot be read; each has a translation under `paper.problem_kinds.<kind>`. */
export const FILE_PROBLEM_KINDS = ['conflict_markers', 'invalid_yaml', 'invalid_schema'] as const
export type FileProblemKind = (typeof FILE_PROBLEM_KINDS)[number]

/** A web page's publication date as «Editar metadatos» takes it: YYYY, YYYY-MM or YYYY-MM-DD. */
export const METADATA_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/

/**
 * «Editar metadatos»: the fields the user changed (undefined: left as is; null: removed). `date` is a web page's
 * publication date (YYYY, YYYY-MM or YYYY-MM-DD) and sets the year with it.
 */
export interface MetadataEdit {
  title?: string
  authors?: Author[]
  year?: number | null
  date?: string | null
  venue?: string | null
  url?: string | null
}

/** A metadata edit: `undoToken` is what «Deshacer» sends back (null when nothing changed). */
export type MetadataEditResult = { ok: true; undoToken: string | null } | { ok: false; error: string }

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
  'facets_nothing_to_fill',
  'mapping_searched',
  'mapping_search_partial',
  'snowballed',
  'screening_suggested'
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
