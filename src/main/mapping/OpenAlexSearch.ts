import { SEARCH_CAP, type WorkCandidate } from '../../shared/mapping'
import type { Author, PaperKind } from '../../shared/schemas'
import type { HttpClient } from '../ingest/http'
import { normalizeDoi } from '../ingest/identifiers'
import { invertedIndexToText, KIND_BY_OPENALEX } from '../ingest/MetadataResolver'
import { authorFromDisplayName, bareOpenAlexId } from '../ingest/openalex'

const API = 'https://api.openalex.org'
/** Results per page, and ids per lookup: OpenAlex's maximum. */
export const PAGE_SIZE = 100
const FIELDS = 'id,doi,title,display_name,publication_year,type,authorships,primary_location,abstract_inverted_index'

/** OpenAlex's answer as received: every field is checked before use, since nothing guarantees its shape. */
interface RawList {
  meta?: { count?: unknown; next_cursor?: unknown }
  results?: unknown
}

export interface SearchFilter {
  fromYear: number | null
  toYear: number | null
  types: readonly string[]
}

export interface SearchPage {
  works: WorkCandidate[]
  next: string | null
  total: number
}

/** `publication_year:2015-2026,type:article|preprint`; null when there is nothing to filter. */
export function openAlexFilter(f: SearchFilter): string | null {
  const parts: string[] = []
  if (f.fromYear !== null && f.toYear !== null) parts.push(`publication_year:${f.fromYear}-${f.toYear}`)
  else if (f.fromYear !== null) parts.push(`publication_year:>${f.fromYear - 1}`)
  else if (f.toYear !== null) parts.push(`publication_year:<${f.toYear + 1}`)
  if (f.types.length > 0) parts.push(`type:${f.types.join('|')}`)
  return parts.length > 0 ? parts.join(',') : null
}

const query = (p: Record<string, string | null>): string =>
  new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => e[1] !== null)).toString()

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function kindOf(type: unknown): PaperKind | null {
  if (typeof type !== 'string' || !type) return null
  return KIND_BY_OPENALEX[type] ?? (type === 'review' ? 'article' : 'other')
}

function authorsOf(authorships: unknown): Author[] {
  if (!Array.isArray(authorships)) return []
  return authorships.flatMap((a) => {
    const name = isObject(a) && isObject(a.author) ? text(a.author.display_name) : null
    return name ? [authorFromDisplayName(name)] : []
  })
}

function toCandidate(raw: unknown): WorkCandidate[] {
  if (!isObject(raw)) return []
  const id = text(raw.id)
  const title = text(raw.title) ?? text(raw.display_name)
  if (!id || !title) return []
  const doi = text(raw.doi)
  const location = isObject(raw.primary_location) && isObject(raw.primary_location.source) ? raw.primary_location.source : null
  const year = raw.publication_year
  return [
    {
      title,
      authors: authorsOf(raw.authorships),
      year: Number.isSafeInteger(year) ? (year as number) : null,
      venue: location ? text(location.display_name) : null,
      abstract: isObject(raw.abstract_inverted_index) ? invertedIndexToText(raw.abstract_inverted_index as Record<string, number[]>) || null : null,
      kind: kindOf(raw.type),
      identifiers: { ...(doi ? { doi: normalizeDoi(doi) } : {}), openalex: bareOpenAlexId(id) }
    }
  ]
}

/** OpenAlex's work search and lookups for a mapping: list requests that take a little of the daily budget each. */
export class OpenAlexSearch {
  constructor(private readonly http: HttpClient) {}

  /** The request as the search log keeps it: no contact email, no API key. */
  requestUrl(search: string, filter: string | null): string {
    return `${API}/works?${query({ search, filter })}`
  }

  /** One page of results; start with cursor '*', stop when `next` is null. */
  async page(search: string, filter: string | null, cursor: string, signal?: AbortSignal, perPage = PAGE_SIZE): Promise<SearchPage> {
    return (await this.readPage(search, filter, cursor, perPage, signal)).page
  }

  /**
   * Every page of a search up to `cap` results (clamped to 1–`SEARCH_CAP.max`); `capped` when OpenAlex has more.
   * Stops on the last page, an empty page or a cursor OpenAlex already gave, so a bad answer never loops.
   */
  async search(search: string, filter: string | null, cap: number, signal?: AbortSignal): Promise<SearchPage & { capped: boolean }> {
    const limit = Math.min(SEARCH_CAP.max, Math.max(1, Math.floor(Number.isFinite(cap) ? cap : SEARCH_CAP.default)))
    const works: WorkCandidate[] = []
    const seen = new Set<string>()
    let cursor: string | null = '*'
    let read = 0
    let total = 0
    while (cursor !== null && read < limit) {
      signal?.throwIfAborted()
      seen.add(cursor)
      const { page, results } = await this.readPage(search, filter, cursor, Math.min(PAGE_SIZE, limit - read), signal)
      total = page.total
      read += results
      works.push(...page.works)
      cursor = results > 0 && page.next !== null && !seen.has(page.next) ? page.next : null
    }
    return { works, next: cursor, total, capped: total > read }
  }

  /** Works by OpenAlex id, with their abstracts, 100 per request; unknown or untitled works are left out. */
  async works(ids: string[], signal?: AbortSignal): Promise<WorkCandidate[]> {
    const out: WorkCandidate[] = []
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      signal?.throwIfAborted()
      const chunk = ids.slice(i, i + PAGE_SIZE)
      const raw = await this.list({ filter: `ids.openalex:${chunk.join('|')}`, select: FIELDS, 'per-page': String(PAGE_SIZE) }, signal)
      out.push(...(Array.isArray(raw.results) ? raw.results : []).flatMap(toCandidate))
    }
    return out
  }

  private async readPage(search: string, filter: string | null, cursor: string, perPage: number, signal?: AbortSignal): Promise<{ page: SearchPage; results: number }> {
    const raw = await this.list({ search, filter, select: FIELDS, 'per-page': String(perPage), cursor }, signal)
    // A server that ignores `per-page` must not push a search past its cap.
    const results = Array.isArray(raw.results) ? raw.results.slice(0, perPage) : []
    const meta = isObject(raw.meta) ? raw.meta : {}
    const total = typeof meta.count === 'number' && Number.isFinite(meta.count) && meta.count > 0 ? Math.floor(meta.count) : 0
    return { page: { works: results.flatMap(toCandidate), next: text(meta.next_cursor), total }, results: results.length }
  }

  private async list(params: Record<string, string | null>, signal?: AbortSignal): Promise<RawList> {
    const raw = await this.http.json<unknown>(this.http.politeUrl(`${API}/works?${query(params)}`), 'application/json', signal)
    return isObject(raw) ? raw : {}
  }
}
