import type { Author, PaperKind } from '../../shared/schemas'

const HEAD = /^\s*@(\w+)\s*\{\s*([^,\s]*)\s*,/

export function rekeyBibtex(entry: string, key: string): string {
  const m = entry.match(HEAD)
  if (!m) throw new Error('Not a BibTeX entry')
  return entry.replace(HEAD, () => `@${m[1]}{${key},`).trim()
}

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}'
}

/** Accented letters stay as UTF-8 (biber and modern bibtex setups read it). */
export function escapeLatex(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) => SPECIAL[c])
}

/** `family`-only names (organizations, bylines) are braced so BibTeX does not split them. */
export function formatAuthors(authors: Author[]): string {
  return authors
    .map((a) => (a.given ? `${escapeLatex(a.family)}, ${escapeLatex(a.given)}` : `{${escapeLatex(a.family)}}`))
    .join(' and ')
}

export type BibField = [name: string, value: string | number | undefined, raw?: boolean]

export function buildEntry(type: string, key: string, fields: BibField[]): string {
  const lines = fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value, raw]) => `  ${name} = {${raw ? String(value) : escapeLatex(String(value))}}`)
  return `@${type}{${key},\n${lines.join(',\n')}\n}`
}

export function buildOnlineEntry(p: {
  key: string
  title: string
  authors: Author[]
  site?: string
  date?: string
  year?: number
  url: string
  urldate: string
}): string {
  return buildEntry('online', p.key, [
    ['author', p.authors.length ? formatAuthors(p.authors) : undefined, true],
    ['title', p.title],
    ['organization', p.site],
    ['date', p.date, true],
    ['year', p.date ? undefined : p.year],
    ['url', p.url, true],
    ['urldate', p.urldate, true]
  ])
}

const TYPE_BY_KIND: Record<PaperKind, string> = {
  article: 'article',
  conference: 'inproceedings',
  preprint: 'misc',
  book: 'book',
  chapter: 'incollection',
  thesis: 'thesis',
  report: 'techreport',
  web: 'online',
  other: 'misc'
}

const VENUE_FIELD: Partial<Record<PaperKind, string>> = {
  article: 'journal',
  conference: 'booktitle',
  chapter: 'booktitle',
  report: 'institution'
}

/** Used only when no publisher BibTeX exists (e.g. a PDF without DOI). */
export function buildFallbackEntry(p: {
  key: string
  kind: PaperKind
  title: string
  authors: Author[]
  year?: number
  venue?: string
  doi?: string
  arxiv?: string
  url?: string
}): string {
  const venueField = VENUE_FIELD[p.kind]
  return buildEntry(TYPE_BY_KIND[p.kind], p.key, [
    ['author', p.authors.length ? formatAuthors(p.authors) : undefined, true],
    ['title', p.title],
    ['year', p.year],
    ...(venueField ? [[venueField, p.venue] as BibField] : []),
    ['doi', p.doi, true],
    ['eprint', p.arxiv, true],
    ['archiveprefix', p.arxiv ? 'arXiv' : undefined, true],
    ['url', p.url, true]
  ])
}
