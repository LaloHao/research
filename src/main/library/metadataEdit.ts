import { METADATA_DATE, type MetadataEdit } from '../../shared/library'
import type { Paper } from '../../shared/schemas'
import { bibFields } from '../../shared/writing/bibtex'
import { bibType, buildFallbackEntry, buildOnlineEntry, formatAuthors, setBibFields } from '../ingest/bibtex'
import { InvalidEdit } from '../summary/merge'
import { compact } from './buildPaper'

/** Fields that name where a work appeared, in the order one already in the entry is chosen. */
const VENUE_FIELDS = ['journal', 'journaltitle', 'booktitle', 'organization', 'institution', 'school', 'howpublished', 'publisher']

/** Where an entry of this type keeps its venue when it has none yet. */
const VENUE_BY_TYPE: Record<string, string> = {
  article: 'journal',
  inproceedings: 'booktitle',
  incollection: 'booktitle',
  online: 'organization',
  techreport: 'institution',
  thesis: 'school',
  phdthesis: 'school',
  mastersthesis: 'school',
  book: 'publisher'
}


type BibChange = { value: string; raw?: boolean } | null

/**
 * The paper with the user's edit applied: paper.yaml fields and the same fields in its BibTeX entry. Fields the
 * edit leaves out (undefined) stay as they are; null removes one. Metadata a user completed (title, authors and a
 * year) counts as complete. The id and the entry's key never change.
 */
export function applyMetadataEdit(paper: Paper, edit: MetadataEdit): Paper {
  const next: Paper = { ...paper, identifiers: { ...paper.identifiers } }
  const bib: Record<string, BibChange> = {}
  const fields = safeFields(paper.bibtex)
  if (edit.title !== undefined) {
    const title = edit.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new InvalidEdit('A paper needs a title')
    next.title = title
    bib.title = { value: title }
  }
  if (edit.authors !== undefined) {
    const authors = edit.authors.flatMap((a) => {
      const family = a.family.trim()
      const given = a.given?.trim()
      return family ? [given ? { family, given } : { family }] : []
    })
    next.authors = authors
    bib.author = authors.length ? { value: formatAuthors(authors), raw: true } : null
  }
  if (edit.date) {
    if (!METADATA_DATE.test(edit.date)) throw new InvalidEdit('Dates are YYYY, YYYY-MM or YYYY-MM-DD')
    // A full date says the year too: one field, as buildOnlineEntry writes it.
    next.year = Number(edit.date.slice(0, 4))
    bib.date = { value: edit.date, raw: true }
    bib.year = null
  } else {
    if (edit.date === null) bib.date = null
    if (edit.year !== undefined) {
      if (edit.year === null) delete next.year
      else next.year = edit.year
      bib.year = edit.year === null ? null : { value: String(edit.year), raw: true }
      // A date of another year would contradict it.
      const date = fields?.get('date')
      if (date && edit.date === undefined && (edit.year === null || !date.startsWith(String(edit.year)))) bib.date = null
    }
  }
  if (edit.venue !== undefined) {
    const venue = edit.venue?.replace(/\s+/g, ' ').trim() || null
    if (venue) next.venue = venue
    else delete next.venue
    const name = VENUE_FIELDS.find((f) => fields?.has(f)) ?? VENUE_BY_TYPE[bibType(paper.bibtex) ?? ''] ?? 'howpublished'
    bib[name] = venue ? { value: venue } : null
  }
  if (edit.url !== undefined) {
    const url = edit.url?.trim() || null
    if (url) next.identifiers.url = url
    else delete next.identifiers.url
    bib.url = url ? { value: url, raw: true } : null
  }
  next.bibtex = fields ? setBibFields(paper.bibtex, bib) : rebuiltEntry(next)
  if (next.title && next.authors.length > 0 && next.year !== undefined) next.metadata_status = 'complete'
  return compact(next) as Paper
}

function safeFields(entry: string): Map<string, string> | null {
  return bibType(entry) ? bibFields(entry) : null
}

/** An entry that could not be read is written again from the paper's fields. */
function rebuiltEntry(p: Paper): string {
  const url = p.identifiers.url
  if (p.kind === 'web' && url) {
    return buildOnlineEntry({ key: p.id, title: p.title, authors: p.authors, site: p.venue, year: p.year, url, urldate: p.added_at.slice(0, 10) })
  }
  return buildFallbackEntry({ key: p.id, kind: p.kind, title: p.title, authors: p.authors, year: p.year, venue: p.venue, doi: p.identifiers.doi, arxiv: p.identifiers.arxiv, url })
}
