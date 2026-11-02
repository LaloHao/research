import type { Author, PaperKind } from '../../shared/schemas'
import { buildEntry, formatAuthors, type BibField } from './bibtex'
import { HttpError, type HttpClient } from './http'
import { arxivDoi, arxivFromDoi, normalizeDoi } from './identifiers'
import { authorFromDisplayName, bareOpenAlexId } from './openalex'
import type { ResolvedMetadata } from './types'

export interface MetadataSource {
  byDoi(doi: string, signal?: AbortSignal): Promise<ResolvedMetadata>
  byArxiv(id: string, signal?: AbortSignal): Promise<ResolvedMetadata>
  byOpenAlex(id: string, signal?: AbortSignal): Promise<ResolvedMetadata>
  /** A book by its ISBN-13 (normalizeIsbn): Open Library, then Google Books for what it lacks. */
  byIsbn(isbn: string, signal?: AbortSignal): Promise<ResolvedMetadata>
}

interface CslName {
  family?: string
  given?: string
  literal?: string
}

interface CslDate {
  'date-parts'?: (number | string)[][]
}

export interface Csl {
  type?: string
  title?: string | string[]
  author?: CslName[]
  issued?: CslDate
  published?: CslDate
  'container-title'?: string | string[]
  abstract?: string
  DOI?: string
}

interface OpenAlexWork {
  id?: string
  abstract_inverted_index?: Record<string, number[]> | null
  best_oa_location?: { pdf_url?: string | null } | null
}

interface OpenAlexFullWork extends OpenAlexWork {
  doi?: string | null
  title?: string | null
  publication_year?: number | null
  type?: string | null
  authorships?: { author?: { display_name?: string | null } }[]
  primary_location?: { source?: { display_name?: string | null } | null } | null
}

const OPENALEX_FIELDS = 'id,doi,title,publication_year,type,authorships,primary_location,abstract_inverted_index,best_oa_location'

export const KIND_BY_OPENALEX: Record<string, PaperKind> = {
  article: 'article',
  'conference-paper': 'conference',
  preprint: 'preprint',
  book: 'book',
  'book-chapter': 'chapter',
  dissertation: 'thesis',
  report: 'report'
}

const CSL_ACCEPT = 'application/vnd.citationstyles.csl+json'
const BIBTEX_ACCEPT = 'application/x-bibtex'

const KIND_BY_CSL: Record<string, PaperKind> = {
  'journal-article': 'article',
  'article-journal': 'article',
  article: 'article',
  'proceedings-article': 'conference',
  'paper-conference': 'conference',
  'posted-content': 'preprint',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'book-chapter': 'chapter',
  chapter: 'chapter',
  dissertation: 'thesis',
  thesis: 'thesis',
  report: 'report'
}

const encodeDoi = (doi: string): string => doi.split('/').map(encodeURIComponent).join('/')
const first = (v?: string | string[]): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim() || undefined
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

export class MetadataResolver implements MetadataSource {
  constructor(private readonly http: HttpClient) {}

  async byDoi(rawDoi: string, signal?: AbortSignal): Promise<ResolvedMetadata> {
    const doi = normalizeDoi(rawDoi)
    const url = `https://doi.org/${encodeDoi(doi)}`
    const meta = fromCsl(await this.http.json<Csl>(url, CSL_ACCEPT, signal))
    meta.identifiers.doi = doi
    const [bibtex, work] = await Promise.all([
      this.http.text(url, BIBTEX_ACCEPT, signal).catch(() => undefined),
      this.http
        .json<OpenAlexWork>(this.http.politeUrl(`https://api.openalex.org/works/doi:${encodeDoi(doi)}`), 'application/json', signal)
        .catch(() => undefined)
    ])
    if (bibtex && /^\s*@\w+\s*\{/.test(bibtex)) meta.bibtex = bibtex.trim()
    if (work) applyOpenAlex(meta, work)
    const arxiv = arxivFromDoi(doi)
    if (arxiv) {
      meta.kind = 'preprint'
      meta.identifiers.arxiv = arxiv
      meta.oa_pdf_url ??= `https://arxiv.org/pdf/${arxiv}`
    }
    if (!meta.title) {
      meta.title = doi
      meta.complete = false
    }
    return meta
  }

  byArxiv(id: string, signal?: AbortSignal): Promise<ResolvedMetadata> {
    return this.byDoi(arxivDoi(id), signal)
  }

  /** A candidate without a DOI is added through its OpenAlex record; with a DOI, the DOI path gives better BibTeX. */
  async byOpenAlex(id: string, signal?: AbortSignal): Promise<ResolvedMetadata> {
    const work = await this.http.json<OpenAlexFullWork>(this.http.politeUrl(`https://api.openalex.org/works/${id}?select=${OPENALEX_FIELDS}`), 'application/json', signal)
    if (work.doi) {
      const meta = await this.byDoi(work.doi, signal)
      meta.identifiers.openalex ??= bareOpenAlexId(work.id ?? id)
      return meta
    }
    return fromOpenAlexWork(work, id)
  }

  async byIsbn(isbn: string, signal?: AbortSignal): Promise<ResolvedMetadata> {
    const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
    let olError: unknown = null
    const ol = await this.http
      .json<Record<string, OpenLibraryBook>>(olUrl, 'application/json', signal)
      .then((r) => fromOpenLibrary(r[`ISBN:${isbn}`]))
      .catch((error: unknown) => {
        if (signal?.aborted) throw error
        olError = error
        return null
      })
    // Google Books only fills what Open Library lacks: without a key its quota is small and often spent.
    const google =
      ol && ol.title && ol.authors.length && ol.year && ol.publisher
        ? null
        : await this.http
            .json<GoogleBooksAnswer>(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, 'application/json', signal)
            .then((r) => fromGoogleBooks(r.items?.[0]?.volumeInfo))
            .catch((error: unknown) => {
              if (signal?.aborted) throw error
              return null
            })
    const book = mergeBooks(ol, google)
    // Open Library failing (network, 5xx) is not «not found»: that error is the one to show.
    if (!book?.title) throw olError ?? new HttpError(404, olUrl)
    return bookMetadata(isbn, book)
  }
}

interface OpenLibraryBook {
  title?: string
  subtitle?: string
  authors?: { name?: string }[]
  by_statement?: string
  publishers?: { name?: string }[]
  publish_date?: string
}

interface GoogleVolume {
  title?: string
  subtitle?: string
  authors?: string[]
  publisher?: string
  publishedDate?: string
  description?: string
}

interface GoogleBooksAnswer {
  items?: { volumeInfo?: GoogleVolume }[]
}

interface Book {
  title?: string
  authors: Author[]
  /** The names are the book's editors («edited by …»): BibTeX `editor`, not `author`. */
  edited: boolean
  year?: number
  publisher?: string
  abstract?: string
}

const yearIn = (s?: string): number | undefined => {
  const m = s?.match(/\b(1[5-9]\d\d|20\d\d)\b/)
  return m ? Number(m[1]) : undefined
}

const bookTitle = (title?: string, subtitle?: string): string | undefined => {
  const t = title?.trim()
  if (!t) return undefined
  const sub = subtitle?.trim()
  return sub && !t.toLowerCase().includes(sub.toLowerCase()) ? `${t}: ${sub}` : t
}

/** «Jones, Chris (Computer engineer)» or «Betsy Beyer» (Open Library writes both). */
export function bookAuthor(name: string): Author | null {
  const clean = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const comma = clean.match(/^([^,]+),\s*(.+)$/)
  return comma ? { family: comma[1].trim(), given: comma[2].trim() } : authorFromDisplayName(clean)
}

function fromOpenLibrary(b?: OpenLibraryBook): Book | null {
  if (!b) return null
  return {
    title: bookTitle(b.title, b.subtitle),
    authors: (b.authors ?? []).flatMap((a) => (a.name ? [bookAuthor(a.name)].filter((x): x is Author => !!x) : [])),
    edited: /^\s*edited\b/i.test(b.by_statement ?? ''),
    year: yearIn(b.publish_date),
    publisher: b.publishers?.[0]?.name?.trim() || undefined
  }
}

function fromGoogleBooks(v?: GoogleVolume): Book | null {
  if (!v) return null
  return {
    title: bookTitle(v.title, v.subtitle),
    authors: (v.authors ?? []).flatMap((n) => [bookAuthor(n)].filter((x): x is Author => !!x)),
    edited: false,
    year: yearIn(v.publishedDate),
    publisher: v.publisher?.trim() || undefined,
    abstract: v.description ? stripTags(v.description) : undefined
  }
}

function mergeBooks(a: Book | null, b: Book | null): Book | null {
  if (!a || !b) return a ?? b
  return {
    title: a.title ?? b.title,
    authors: a.authors.length ? a.authors : b.authors,
    edited: a.authors.length ? a.edited : b.edited,
    year: a.year ?? b.year,
    publisher: a.publisher ?? b.publisher,
    abstract: a.abstract ?? b.abstract
  }
}

function bookMetadata(isbn: string, book: Book): ResolvedMetadata {
  const title = book.title ?? isbn
  const names = book.authors.length ? formatAuthors(book.authors) : undefined
  const fields: BibField[] = [
    [book.edited ? 'editor' : 'author', names, true],
    ['title', title],
    ['publisher', book.publisher],
    ['year', book.year],
    ['isbn', isbn, true]
  ]
  return {
    kind: 'book',
    title,
    authors: book.authors,
    year: book.year,
    venue: book.publisher,
    abstract: book.abstract,
    identifiers: { isbn },
    // The key is replaced when the paper is built (rekeyBibtex).
    bibtex: buildEntry('book', 'isbn', fields),
    complete: !!book.title && book.authors.length > 0 && book.year !== undefined
  }
}

export function fromCsl(csl: Csl): ResolvedMetadata {
  const year = Number(csl.issued?.['date-parts']?.[0]?.[0] ?? csl.published?.['date-parts']?.[0]?.[0])
  return {
    kind: KIND_BY_CSL[csl.type ?? ''] ?? 'other',
    title: stripTags(first(csl.title) ?? ''),
    authors: (csl.author ?? []).flatMap((a) =>
      a.family ? [{ family: a.family, ...(a.given ? { given: a.given } : {}) }] : a.literal ? [{ family: a.literal }] : []
    ),
    year: Number.isInteger(year) && year > 0 ? year : undefined,
    venue: first(csl['container-title']),
    abstract: csl.abstract ? stripTags(csl.abstract) : undefined,
    identifiers: { doi: csl.DOI?.toLowerCase() },
    complete: true
  }
}

export function fromOpenAlexWork(work: OpenAlexFullWork, id: string): ResolvedMetadata {
  const title = work.title?.trim() ?? ''
  const authors = (work.authorships ?? []).flatMap((a) => (a.author?.display_name ? [authorFromDisplayName(a.author.display_name)] : []))
  const year = work.publication_year ?? undefined
  const meta: ResolvedMetadata = {
    kind: KIND_BY_OPENALEX[work.type ?? ''] ?? 'other',
    title: title || id,
    authors,
    year,
    venue: work.primary_location?.source?.display_name?.trim() || undefined,
    identifiers: { openalex: bareOpenAlexId(work.id ?? id) },
    complete: Boolean(title && authors.length && year)
  }
  applyOpenAlex(meta, work)
  return meta
}

function applyOpenAlex(meta: ResolvedMetadata, work: OpenAlexWork): void {
  if (work.id) meta.identifiers.openalex = work.id.replace('https://openalex.org/', '')
  if (!meta.abstract && work.abstract_inverted_index) meta.abstract = invertedIndexToText(work.abstract_inverted_index)
  const pdf = work.best_oa_location?.pdf_url
  if (pdf) meta.oa_pdf_url = pdf
}

/** Highest word position read from an abstract index: anything past it is malformed, not a real abstract. */
const MAX_ABSTRACT_POSITION = 50_000

/** OpenAlex's `abstract_inverted_index` back to text; malformed words or positions are skipped, never thrown on. */
export function invertedIndexToText(index: Record<string, number[]>): string {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return ''
  const words = new Map<number, string>()
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!word || !Array.isArray(positions)) continue
    for (const p of positions) if (Number.isSafeInteger(p) && p >= 0 && p <= MAX_ABSTRACT_POSITION) words.set(p as number, word)
  }
  return [...words.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1])
    .join(' ')
}
