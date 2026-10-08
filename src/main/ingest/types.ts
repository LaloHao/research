import type { Author, PaperKind } from '../../shared/schemas'

/** What any metadata source (DOI, arXiv, web page, PDF) hands to the library. */
export interface ResolvedMetadata {
  kind: PaperKind
  title: string
  authors: Author[]
  year?: number
  venue?: string
  abstract?: string
  identifiers: { doi?: string; arxiv?: string; openalex?: string; url?: string }
  oa_pdf_url?: string
  /** Publisher/registry BibTeX with whatever key it came with. */
  bibtex?: string
  web?: { site: string; date?: string }
  complete: boolean
}
