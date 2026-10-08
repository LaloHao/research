import { PaperSchema, type Paper } from '../../shared/schemas'
import { buildFallbackEntry, buildOnlineEntry, rekeyBibtex } from '../ingest/bibtex'
import type { ResolvedMetadata } from '../ingest/types'

export function buildPaper(meta: ResolvedMetadata, id: string, now: Date): Paper {
  const iso = now.toISOString()
  const url = meta.identifiers.url
  const bibtex = meta.bibtex
    ? rekeyBibtex(meta.bibtex, id)
    : meta.kind === 'web' && url
      ? buildOnlineEntry({ key: id, title: meta.title, authors: meta.authors, site: meta.web?.site, date: meta.web?.date, year: meta.year, url, urldate: iso.slice(0, 10) })
      : buildFallbackEntry({ key: id, kind: meta.kind, title: meta.title, authors: meta.authors, year: meta.year, venue: meta.venue, doi: meta.identifiers.doi, arxiv: meta.identifiers.arxiv, url })
  return PaperSchema.parse({
    schema_version: 1,
    id,
    kind: meta.kind,
    title: meta.title,
    authors: meta.authors,
    year: meta.year,
    venue: meta.venue,
    abstract: meta.abstract,
    identifiers: compact(meta.identifiers),
    oa_pdf_url: meta.oa_pdf_url,
    bibtex,
    metadata_status: meta.complete ? 'complete' : 'incomplete',
    added_at: iso,
    updated_at: iso
  })
}

export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>
}
