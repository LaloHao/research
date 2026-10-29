import { METADATA_DATE, type MetadataEdit } from '../../shared/library'
import type { Author, Paper } from '../../shared/schemas'
import { bibFields } from '../../shared/writing/bibtex'
import { isWebAddress } from './appBrowser'

/** «Editar metadatos» as the form holds it: text fields, authors one per line. */
export interface MetadataForm {
  title: string
  authors: string
  year: string
  /** Web pages only: the publication date (YYYY, YYYY-MM or YYYY-MM-DD). */
  date: string
  venue: string
  url: string
}

export type MetadataFormError = 'title' | 'year' | 'date' | 'url'

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
  let date = ''
  try {
    date = bibFields(paper.bibtex).get('date') ?? ''
  } catch {
    // An unreadable entry has no date to show.
  }
  return {
    title: paper.title,
    authors: authorsText(paper.authors),
    year: paper.year !== undefined ? String(paper.year) : '',
    date: METADATA_DATE.test(date) ? date : '',
    venue: paper.venue ?? '',
    url: paper.identifiers.url ?? ''
  }
}

/** Only the fields the user changed, checked; an emptied field is removed (null). */
export function editFromForm(paper: Paper, form: MetadataForm): { edit: MetadataEdit } | { error: MetadataFormError } {
  const before = formFromPaper(paper)
  const edit: MetadataEdit = {}
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
  return { edit }
}
