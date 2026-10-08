import type { Paper } from './schemas'

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
  'unknown'
] as const
export type UserErrorCode = (typeof USER_ERROR_CODES)[number]

/** Why a paper.yaml cannot be read; each has a translation under `paper.problem_kinds.<kind>`. */
export const FILE_PROBLEM_KINDS = ['conflict_markers', 'invalid_yaml', 'invalid_schema'] as const
export type FileProblemKind = (typeof FILE_PROBLEM_KINDS)[number]

export const INGEST_STATUSES = ['added', 'merged', 'duplicate'] as const
export type IngestStatus = (typeof INGEST_STATUSES)[number]

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
}
