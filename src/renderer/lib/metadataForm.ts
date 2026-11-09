import { METADATA_DATE, type MetadataEdit } from '../../shared/library'
import type { Author, Paper, PaperKind } from '../../shared/schemas'
import { bibFields } from '../../shared/writing/bibtex'
import { normalizeIsbn } from '../../shared/isbn'
import { isWebAddress } from './appBrowser'

/** «Editar metadatos» as the form holds it: text fields, authors one per line. */
export interface MetadataForm {
  kind: PaperKind
  title: string
  authors: string
  year: string
  /** Web pages only: the publication date (YYYY, YYYY-MM or YYYY-MM-DD). */
  date: string
  venue: string
  url: string
  /** Books and chapters: one per line, as the authors. */
  editors: string
  /** Chapters only (a book's publisher is its venue). */
  publisher: string
  chapter: string
  pages: string
  /** Books and chapters. */
  isbn: string
}

/** Which fields «Editar metadatos» shows for a kind of paper. */
export function formFields(kind: PaperKind): { date: boolean; editors: boolean; publisher: boolean; chapter: boolean; pages: boolean; isbn: boolean } {
  const chapter = kind === 'chapter'
  return { date: kind === 'web', editors: chapter || kind === 'book', publisher: chapter, chapter, pages: chapter || kind === 'article' || kind === 'conference', isbn: chapter || kind === 'book' }
}

export type MetadataFormError = 'title' | 'year' | 'date' | 'url' | 'isbn'

/** One line per author, «Apellido, Nombre»; an author without a given name (an organization) is just its name. */
export function authorsText(authors: Author[]): string {
  return authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('\n')
}

/** «Apellido, Nombre» or «Nombre Apellido» per line; a single word (or a name in braces) is kept whole. */
export function parseAuthors(text: string): Author[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line): Author => {
      const braced = /^\{(.+)\}$/.exec(line)
      if (braced) return { family: braced[1].trim() }
      const comma = line.indexOf(',')
      if (comma > 0) {
        const given = line.slice(comma + 1).trim()
        return given ? { family: line.slice(0, comma).trim(), given } : { family: line.slice(0, comma).trim() }
      }
      const words = line.split(' ')
      return words.length < 2 ? { family: line } : { family: words[words.length - 1], given: words.slice(0, -1).join(' ') }
    })
}

export function formFromPaper(paper: Paper): MetadataForm {
  let fields = new Map<string, string>()
  try {
    fields = bibFields(paper.bibtex)
  } catch {
    // An unreadable entry has no fields to show.
  }
  const date = fields.get('date') ?? ''
  return {
    kind: paper.kind,
    title: paper.title,
    authors: authorsText(paper.authors),
    year: paper.year !== undefined ? String(paper.year) : '',
    date: METADATA_DATE.test(date) ? date : '',
    venue: paper.venue ?? '',
    url: paper.identifiers.url ?? '',
    editors: (fields.get('editor') ?? '').split(/\s+and\s+/).filter(Boolean).join('\n'),
    publisher: fields.get('publisher') ?? '',
    chapter: fields.get('chapter') ?? '',
    pages: (fields.get('pages') ?? '').replace(/-+/g, '-'),
    isbn: paper.identifiers.isbn ?? ''
  }
}

/** Only the fields the user changed, checked; an emptied field is removed (null). */
export function editFromForm(paper: Paper, form: MetadataForm): { edit: MetadataEdit } | { error: MetadataFormError } {
  const before = formFromPaper(paper)
  const edit: MetadataEdit = {}
  if (form.kind !== before.kind) edit.kind = form.kind
  const title = form.title.replace(/\s+/g, ' ').trim()
  if (!title) return { error: 'title' }
  if (title !== before.title) edit.title = title
  const authors = parseAuthors(form.authors)
  if (JSON.stringify(authors) !== JSON.stringify(parseAuthors(before.authors))) edit.authors = authors
  const date = form.date.trim()
  if (date && !METADATA_DATE.test(date)) return { error: 'date' }
  if (date !== before.date) edit.date = date || null
  const year = form.year.trim()
  if (year && !/^\d{4}$/.test(year)) return { error: 'year' }
  // A date sets its own year.
  if (!date && year !== before.year) edit.year = year ? Number(year) : null
  const venue = form.venue.replace(/\s+/g, ' ').trim()
  if (venue !== before.venue) edit.venue = venue || null
  const url = form.url.trim()
  if (url && !isWebAddress(url)) return { error: 'url' }
  if (url !== before.url) edit.url = url || null
  const editors = parseAuthors(form.editors)
  if (JSON.stringify(editors) !== JSON.stringify(parseAuthors(before.editors))) edit.editors = editors
  for (const field of ['publisher', 'chapter', 'pages'] as const) {
    const value = form[field].replace(/\s+/g, ' ').trim()
    if (value !== before[field]) edit[field] = value || null
  }
  const isbn = form.isbn.trim()
  if (isbn && !normalizeIsbn(isbn)) return { error: 'isbn' }
  if (isbn !== before.isbn) edit.isbn = isbn || null
  return { edit }
}
