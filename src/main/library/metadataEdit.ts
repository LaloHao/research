import { normalizeIsbn } from '../../shared/isbn'
import { METADATA_DATE, type MetadataEdit } from '../../shared/library'
import type { Author, Paper } from '../../shared/schemas'
import { bibFields } from '../../shared/writing/bibtex'
import { bibType, buildFallbackEntry, buildOnlineEntry, formatAuthors, setBibFields, setBibType, TYPE_BY_KIND } from '../ingest/bibtex'
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
 * edit leaves out (undefined) stay as they are; null removes one. A new kind changes the entry's type and moves the
 * venue to the field that type keeps it in (a web page's site becomes a chapter's book title). Metadata a user
 * completed (title, authors and a year) counts as complete. The id and the entry's key never change.
 */
export function applyMetadataEdit(paper: Paper, edit: MetadataEdit): Paper {
  const next: Paper = { ...paper, identifiers: { ...paper.identifiers } }
  const bib: Record<string, BibChange> = {}
  let entry = paper.bibtex
  let fields = safeFields(entry)
  if (edit.kind !== undefined && edit.kind !== paper.kind) {
    next.kind = edit.kind
    if (fields) {
      const type = TYPE_BY_KIND[edit.kind]
      const from = VENUE_FIELDS.find((f) => fields!.has(f))
      const to = VENUE_BY_TYPE[type]
      entry = setBibType(entry, type)
      // Where the old type kept the venue is not where the new one looks for it; a field the new type already has stays.
      if (from && to && from !== to && !fields.has(to)) entry = setBibFields(entry, { [from]: null, [to]: { value: fields.get(from)!, raw: true } })
      fields = safeFields(entry)
    }
  }
  if (edit.title !== undefined) {
    const title = edit.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new InvalidEdit('A paper needs a title')
    next.title = title
    bib.title = { value: title }
  }
  if (edit.authors !== undefined) {
    const authors = cleanAuthors(edit.authors)
    next.authors = authors
    bib.author = authors.length ? { value: formatAuthors(authors), raw: true } : null
  }
  if (edit.editors !== undefined) {
    const editors = cleanAuthors(edit.editors)
    bib.editor = editors.length ? { value: formatAuthors(editors), raw: true } : null
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
    const venue = oneLine(edit.venue)
    if (venue) next.venue = venue
    else delete next.venue
    const name = VENUE_FIELDS.find((f) => fields?.has(f)) ?? VENUE_BY_TYPE[bibType(entry) ?? ''] ?? 'howpublished'
    bib[name] = venue ? { value: venue } : null
  }
  if (edit.publisher !== undefined) bib.publisher = textChange(edit.publisher)
  if (edit.chapter !== undefined) bib.chapter = textChange(edit.chapter)
  if (edit.pages !== undefined) {
    // A range is written with BibTeX's en dash.
    const pages = oneLine(edit.pages)?.replace(/\s*[-–—]+\s*/g, '--') ?? null
    bib.pages = pages ? { value: pages, raw: true } : null
  }
  if (edit.isbn !== undefined) {
    const isbn = edit.isbn?.trim() ? normalizeIsbn(edit.isbn) : null
    if (edit.isbn?.trim() && !isbn) throw new InvalidEdit('Not an ISBN')
    if (isbn) next.identifiers.isbn = isbn
    else delete next.identifiers.isbn
    bib.isbn = isbn ? { value: isbn, raw: true } : null
  }
  if (edit.url !== undefined) {
    const url = edit.url?.trim() || null
    if (url) next.identifiers.url = url
    else delete next.identifiers.url
    bib.url = url ? { value: url, raw: true } : null
  }
  next.bibtex = setBibFields(fields ? entry : rebuiltEntry(next), bib)
  if (next.title && next.authors.length > 0 && next.year !== undefined) next.metadata_status = 'complete'
  return compact(next) as Paper
}

function cleanAuthors(authors: Author[]): Author[] {
  return authors.flatMap((a) => {
    const family = a.family.trim()
    const given = a.given?.trim()
    return family ? [given ? { family, given } : { family }] : []
  })
}

function oneLine(text: string | null): string | null {
  return text?.replace(/\s+/g, ' ').trim() || null
}

function textChange(text: string | null): BibChange {
  const value = oneLine(text)
  return value ? { value } : null
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
  return buildFallbackEntry({ key: p.id, kind: p.kind, title: p.title, authors: p.authors, year: p.year, venue: p.venue, doi: p.identifiers.doi, arxiv: p.identifiers.arxiv, isbn: p.identifiers.isbn, url })
}
