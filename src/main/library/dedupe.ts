import type { Paper } from '../../shared/schemas'
import { rekeyBibtex } from '../ingest/bibtex'
import { asciiFold } from '../ingest/citekey'
import { arxivFromDoi } from '../ingest/identifiers'
import { compact } from './buildPaper'

export interface DedupeEntry {
  id: string
  doi?: string | null
  arxiv?: string | null
  title: string
}

const MIN_TITLE_LENGTH = 15

export function normalizeTitle(t: string): string {
  return asciiFold(t).replace(/[^a-z0-9]+/g, ' ').trim()
}

export function findDuplicate(
  c: { doi?: string; arxiv?: string; title: string },
  existing: DedupeEntry[]
): { id: string; reason: 'doi' | 'arxiv' | 'title' } | null {
  const doi = c.doi?.toLowerCase()
  const arxiv = c.arxiv ?? (doi ? arxivFromDoi(doi) : null)
  for (const e of existing) {
    if (doi && e.doi && e.doi.toLowerCase() === doi) return { id: e.id, reason: 'doi' }
  }
  for (const e of existing) {
    const eArxiv = e.arxiv ?? (e.doi ? arxivFromDoi(e.doi) : null)
    if (arxiv && eArxiv && arxiv === eArxiv) return { id: e.id, reason: 'arxiv' }
  }
  const title = normalizeTitle(c.title)
  if (title.length >= MIN_TITLE_LENGTH) {
    for (const e of existing) if (normalizeTitle(e.title) === title) return { id: e.id, reason: 'title' }
  }
  return null
}

const METADATA_KEYS = ['kind', 'title', 'authors', 'year', 'venue', 'bibtex'] as const

/**
 * Merges a newly ingested record into the one already in the library. The existing id
 * (citation key) always survives. Incoming metadata wins only when it is an upgrade:
 * a published version of a preprint, or complete metadata over incomplete.
 */
export function mergePapers(existing: Paper, incoming: Paper): Paper {
  const upgrade =
    (existing.kind === 'preprint' && incoming.kind !== 'preprint' && incoming.metadata_status === 'complete') ||
    (existing.metadata_status === 'incomplete' && incoming.metadata_status === 'complete')
  const merged: Paper = { ...existing }
  if (upgrade) for (const k of METADATA_KEYS) (merged as Record<string, unknown>)[k] = incoming[k]
  merged.identifiers = upgrade
    ? { ...compact(existing.identifiers), ...compact(incoming.identifiers) }
    : { ...compact(incoming.identifiers), ...compact(existing.identifiers) }
  merged.abstract = existing.abstract ?? incoming.abstract
  merged.oa_pdf_url = existing.oa_pdf_url ?? incoming.oa_pdf_url
  merged.pdf_sha256 = existing.pdf_sha256 ?? incoming.pdf_sha256
  merged.metadata_status = existing.metadata_status === 'complete' || incoming.metadata_status === 'complete' ? 'complete' : 'incomplete'
  merged.bibtex = rekeyBibtex(merged.bibtex, existing.id)
  merged.updated_at = incoming.updated_at
  return compact(merged) as Paper
}

export function samePaperContent(a: Paper, b: Paper): boolean {
  const strip = ({ updated_at: _ignored, ...rest }: Paper): Record<string, unknown> => compact(rest)
  return JSON.stringify(sortKeys(strip(a))) === JSON.stringify(sortKeys(strip(b)))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}
