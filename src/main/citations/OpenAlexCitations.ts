import { authorsLabel } from '../../shared/format'
import type { ExternalWork } from '../../shared/relations'
import { HttpError, type HttpClient } from '../ingest/http'
import { normalizeDoi } from '../ingest/identifiers'
import { authorFromDisplayName, bareOpenAlexId, normalizeTitle } from '../ingest/openalex'

const API = 'https://api.openalex.org'
/** OpenAlex accepts up to 100 values per filter and 100 results per page. */
export const BATCH_SIZE = 100
const CITATION_FIELDS = 'id,doi,referenced_works,cited_by_count'
const WORK_FIELDS = 'id,doi,title,publication_year,authorships,cited_by_count'

export interface WorkCitations {
  openalexId: string
  doi: string | null
  references: string[]
  citedByCount: number
}

interface RawWork {
  id?: string
  doi?: string | null
  title?: string | null
  publication_year?: number | null
  referenced_works?: string[]
  cited_by_count?: number
  authorships?: { author?: { display_name?: string | null } }[]
}

interface RawList {
  meta?: { next_cursor?: string | null }
  results?: RawWork[]
}

const encodeDoi = (doi: string): string => doi.split('/').map(encodeURIComponent).join('/')

/**
 * Citation data from OpenAlex. A single-work request is free; list requests (filters, cursor pages, batches) take a
 * little of the daily budget and a search takes more, so search is only used for papers without a DOI.
 */
export class OpenAlexCitations {
  constructor(private readonly http: HttpClient) {}

  work(id: string, signal?: AbortSignal): Promise<WorkCitations | null> {
    return this.single(`/works/${id}`, signal)
  }

  workByDoi(doi: string, signal?: AbortSignal): Promise<WorkCitations | null> {
    return this.single(`/works/doi:${encodeDoi(normalizeDoi(doi))}`, signal)
  }

  /** The id of the one result whose normalized title equals `title` (and year, when known); null if none or several. */
  async findByTitle(title: string, year: number | null, signal?: AbortSignal): Promise<string | null> {
    // `search` is stemmed: OpenAlex answers 400 to a `?` or `*` in it, which a title (a question) may well have.
    const search = title.replace(/[?*]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!search) return null
    const params: Record<string, string> = { search, select: 'id,title,publication_year', 'per-page': '10' }
    if (year) params.filter = `publication_year:${year}`
    const list = await this.list('/works', params, signal)
    const wanted = normalizeTitle(title)
    const hits = (list.results ?? []).filter((r) => r.id && normalizeTitle(r.title ?? '') === wanted)
    return hits.length === 1 ? bareOpenAlexId(hits[0].id!) : null
  }

  /** One page (up to 100) of the works citing `id`; start with cursor '*', stop when `next` is null. */
  async citingPage(id: string, cursor: string, signal?: AbortSignal): Promise<{ ids: string[]; next: string | null }> {
    const list = await this.list('/works', { filter: `cites:${id}`, select: 'id', 'per-page': String(BATCH_SIZE), cursor }, signal)
    return { ids: (list.results ?? []).flatMap((r) => (r.id ? [bareOpenAlexId(r.id)] : [])), next: list.meta?.next_cursor ?? null }
  }

  /**
   * Metadata of many works, one request per 100 ids. Ids OpenAlex does not know are simply missing from the result.
   * `onBatch` gets each batch (the ids asked and the works returned) as it arrives, so a later failure keeps the earlier ones.
   */
  async worksByIds(ids: string[], signal?: AbortSignal, onBatch?: (requested: string[], works: ExternalWork[]) => void): Promise<ExternalWork[]> {
    const works: ExternalWork[] = []
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE)
      const list = await this.list('/works', { filter: `ids.openalex:${chunk.join('|')}`, select: WORK_FIELDS, 'per-page': String(BATCH_SIZE) }, signal)
      const batch = (list.results ?? []).flatMap((raw) => (raw.id ? [toExternalWork(raw, raw.id)] : []))
      onBatch?.(chunk, batch)
      works.push(...batch)
    }
    return works
  }

  private url(path: string, params: Record<string, string>): string {
    return this.http.politeUrl(`${API}${path}?${new URLSearchParams(params).toString()}`)
  }

  private list(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<RawList> {
    return this.http.json<RawList>(this.url(path, params), 'application/json', signal)
  }

  private async single(path: string, signal?: AbortSignal): Promise<WorkCitations | null> {
    try {
      const raw = await this.http.json<RawWork>(this.url(path, { select: CITATION_FIELDS }), 'application/json', signal)
      if (!raw.id) return null
      return {
        openalexId: bareOpenAlexId(raw.id),
        doi: raw.doi ? normalizeDoi(raw.doi) : null,
        references: [...new Set((raw.referenced_works ?? []).map(bareOpenAlexId))],
        citedByCount: raw.cited_by_count ?? 0
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
  }
}

function toExternalWork(raw: RawWork, id: string): ExternalWork {
  const authors = (raw.authorships ?? []).flatMap((a) => (a.author?.display_name ? [authorFromDisplayName(a.author.display_name)] : []))
  return {
    openalexId: bareOpenAlexId(id),
    title: raw.title?.trim() || null,
    year: raw.publication_year ?? null,
    authors: authorsLabel(authors),
    doi: raw.doi ? normalizeDoi(raw.doi) : null,
    citedByCount: raw.cited_by_count ?? null
  }
}
