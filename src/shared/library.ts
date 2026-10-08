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
