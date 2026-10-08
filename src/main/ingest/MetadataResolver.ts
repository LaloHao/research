import type { PaperKind } from '../../shared/schemas'
import type { HttpClient } from './http'
import { arxivDoi, arxivFromDoi, normalizeDoi } from './identifiers'
import type { ResolvedMetadata } from './types'

export interface MetadataSource {
  byDoi(doi: string, signal?: AbortSignal): Promise<ResolvedMetadata>
  byArxiv(id: string, signal?: AbortSignal): Promise<ResolvedMetadata>
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

function applyOpenAlex(meta: ResolvedMetadata, work: OpenAlexWork): void {
  if (work.id) meta.identifiers.openalex = work.id.replace('https://openalex.org/', '')
  if (!meta.abstract && work.abstract_inverted_index) meta.abstract = invertedIndexToText(work.abstract_inverted_index)
  const pdf = work.best_oa_location?.pdf_url
  if (pdf) meta.oa_pdf_url = pdf
}

export function invertedIndexToText(index: Record<string, number[]>): string {
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word
  return words.filter(Boolean).join(' ')
}
