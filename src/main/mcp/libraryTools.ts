import type { SimilarityReason } from '../../shared/relations'
import type { IndexCache } from '../cache/IndexCache'
import type { EmbeddingRuntime } from '../embeddings/EmbeddingRuntime'
import type { MapService } from '../map/MapService'
import type { ProjectStore } from '../project/ProjectStore'
import { normalizeForMatch, normalizeWithMap } from '../../shared/textMatch'
import { cosine } from '../relations/similarity'
import { pagesFromChunks } from '../summary/paperText'

/** A failure the model can act on; its message is returned as the tool's error result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export interface TextHit {
  paper_id: string
  page: number | null
  text: string
}
export interface SimilarHit {
  paper_id: string
  title: string
  year: number | null
  score: number
}
export interface FindHit {
  page: number | null
  /** The occurrence as written in the paper. */
  match: string
  context: string
}
export interface PageOut {
  page: number | null
  text: string
}
export interface PaperCard {
  paper_id: string
  title: string
  authors: string
  year: number | null
  venue: string | null
  abstract: string | null
  summary: Record<string, string> | null
  facets: Record<string, string[]>
  /** Pages of indexed text; page-less (e.g. web) content is counted by its synthetic pages, same as `readPages`. */
  pages: number
}
export interface LinkedOut {
  paper_id: string
  title: string
  year: number | null
}
export interface NeighbourOut extends LinkedOut {
  score: number
  reasons: SimilarityReason[]
}

/** Read-only views of the library for the agent. Papers are named by key; nothing returns a file path. */
export interface LibraryTools {
  searchText(query: string, paperId?: string, limit?: number): Promise<TextHit[]>
  searchSimilar(query: string, limit?: number): Promise<SimilarHit[]>
  findInPaper(paperId: string, text: string, limit?: number): Promise<FindHit[]>
  /**
   * Pages `from`..`to` (inclusive, at most `MAX_PAGES_PER_READ` at a time). Page-less (e.g. web)
   * content is split into ~6000-character numbered "pages" so it can still be read a few at a
   * time the same way. A range entirely past the paper's last page is a `ToolError`.
   */
  readPages(paperId: string, from: number, to: number): Promise<{ paper_id: string; pages: PageOut[] }>
  getPaper(paperId: string): Promise<PaperCard>
  getCitations(paperId: string): Promise<{ paper_id: string; cites: LinkedOut[]; cited_by: LinkedOut[] }>
  getNeighbours(paperId: string): Promise<{ paper_id: string; similar: NeighbourOut[] }>
}

export const MAX_PAGES_PER_READ = 5
const SNIPPET_CHARS = 600
const CONTEXT_CHARS = 150
const MIN_FIND = 2
const MAX_FIND = 200
const MAX_QUERY_CHARS = 200
const MAX_QUERY_WORDS = 20
const MAX_ID_CHARS = 40
const PAGELESS_CHUNK_CHARS = 6000
const SUMMARY_KEYS = ['tldr', 'problem', 'contribution', 'method', 'evaluation', 'results'] as const

const clamp = (n: number | undefined, fallback: number, max: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback
  return Math.min(Math.max(v, 1), max)
}

const BREAK_WINDOW_CHARS = 200
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * The end of the next ~`chunkSize`-character page starting at `start`, never inside a surrogate
 * pair, and preferring a paragraph break (blank line) or, failing that, any whitespace within the
 * last `BREAK_WINDOW_CHARS` characters of the raw cut so a page doesn't end mid-word.
 */
function nextPageEnd(text: string, start: number, chunkSize: number): number {
  const hardEnd = Math.min(start + chunkSize, text.length)
  if (hardEnd >= text.length) return text.length
  let end = hardEnd
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--
  const searchStart = Math.max(start + 1, end - BREAK_WINDOW_CHARS)
  let paragraphBreak = -1
  let whitespaceBreak = -1
  for (let i = end; i >= searchStart; i--) {
    if (whitespaceBreak < 0 && /\s/.test(text[i - 1])) whitespaceBreak = i
    if (text[i - 1] === '\n' && text[i - 2] === '\n') {
      paragraphBreak = i
      break
    }
  }
  const brk = paragraphBreak >= 0 ? paragraphBreak : whitespaceBreak
  if (brk > start) end = brk
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--
  return end
}

/** Splits page-less (e.g. web) content into ~6000-character numbered "pages". */
function syntheticPages(pages: { page: number | null; text: string }[]): { page: number; text: string }[] {
  const full = pages.map((p) => p.text).join('\n\n')
  const out: { page: number; text: string }[] = []
  let start = 0
  while (start < full.length) {
    const end = nextPageEnd(full, start, PAGELESS_CHUNK_CHARS)
    out.push({ page: out.length + 1, text: full.slice(start, end) })
    start = end
  }
  return out.length > 0 ? out : [{ page: 1, text: full }]
}

const stripMarks = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '')

/** `text` folded for literal search (normalizeForMatch, then without accents), with each folded unit's index in the original. */
export function foldWithMap(text: string): { text: string; map: number[] } {
  const n = normalizeWithMap(text)
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < n.text.length; i++) {
    const f = stripMarks(n.text[i])
    for (let k = 0; k < f.length; k++) map.push(n.map[i])
    folded += f
  }
  return { text: folded, map }
}

export const foldQuery = (q: string): string => stripMarks(normalizeForMatch(q))

export function libraryTools(deps: { store: ProjectStore; cache: IndexCache; map: MapService; embeddings: EmbeddingRuntime | null }): LibraryTools {
  const { store, cache, map, embeddings } = deps

  const requirePaper = (id: string) => {
    const row = /^[a-z][a-z0-9]*$/.test(id) ? cache.getPaper(id) : null
    if (!row || row.problem) {
      const shown = id.length > MAX_ID_CHARS ? `${id.slice(0, MAX_ID_CHARS)}…` : id
      throw new ToolError(`Unknown paper id "${shown}". Use the ids given in the prompt or returned by the search tools.`)
    }
    return row
  }
  /** A paper is readable (its row exists and its paper.yaml has no problem); `chunks_fts` rows outlive a `problem`. */
  const isReadable = (id: string): boolean => {
    const row = cache.getPaper(id)
    return Boolean(row) && !row!.problem
  }
  /**
   * The numbered pages the agent sees for `id`: the paper's real pages, or, for page-less (e.g.
   * web) content, the same synthetic ~6000-character split used everywhere a page number is
   * reported, so a page number from `findInPaper` or `getPaper` always lines up with `readPages`.
   */
  const pagesOf = (id: string): { page: number; text: string }[] => {
    const raw = pagesFromChunks(cache.chunksFor(id))
    if (raw.length > 0 && raw.every((p) => p.page === null)) return syntheticPages(raw)
    return raw.filter((p): p is { page: number; text: string } => p.page !== null)
  }
  const linked = (p: { id: string; title: string; year: number | null }): LinkedOut => ({ paper_id: p.id, title: p.title, year: p.year })

  return {
    async searchText(query, paperId, limit) {
      if (paperId !== undefined) requirePaper(paperId)
      const words = query.match(/[\p{L}\p{N}]+/gu)
      if (!words) throw new ToolError('The query has no words to search for.')
      if (query.length > MAX_QUERY_CHARS || words.length > MAX_QUERY_WORDS) throw new ToolError(`Give a query of at most ${MAX_QUERY_CHARS} characters (${MAX_QUERY_WORDS} words).`)
      return cache
        .searchChunks(query, { paperId, limit: clamp(limit, 8, 20) })
        .filter((h) => isReadable(h.paperId))
        .map((h) => ({ paper_id: h.paperId, page: h.page, text: h.text.slice(0, SNIPPET_CHARS) }))
    },

    async searchSimilar(query, limit) {
      const embedder = embeddings ? await embeddings.embedder() : null
      if (!embedder) throw new ToolError('Semantic search is unavailable: the local similarity model is not downloaded. Use search_text instead.')
      if (!query.trim()) throw new ToolError('The query is empty.')
      const [q] = await embedder.embed([query], 'query')
      const rows = new Map(cache.relationRows().map((r) => [r.id, r]))
      return [...cache.vectors(embedder.modelId)]
        .flatMap(([id, v]) => {
          const r = rows.get(id)
          return r ? [{ paper_id: id, title: r.title, year: r.year, score: Math.round(cosine(q, v) * 1000) / 1000 }] : []
        })
        .sort((a, b) => b.score - a.score || a.paper_id.localeCompare(b.paper_id))
        .slice(0, clamp(limit, 5, 20))
    },

    /** Literal text only (no regular expressions from the model run in this process); case and accents are ignored. */
    async findInPaper(paperId, text, limit) {
      requirePaper(paperId)
      const q = foldQuery(text)
      if (q.length < MIN_FIND || text.length > MAX_FIND) throw new ToolError(`Give between ${MIN_FIND} and ${MAX_FIND} characters of literal text.`)
      const max = clamp(limit, 10, 30)
      const hits: FindHit[] = []
      for (const p of pagesOf(paperId)) {
        const f = foldWithMap(p.text)
        for (let at = f.text.indexOf(q); at >= 0; at = f.text.indexOf(q, at + q.length)) {
          const start = f.map[at]
          const end = f.map[at + q.length - 1] + 1
          hits.push({ page: p.page, match: p.text.slice(start, end), context: p.text.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS) })
          if (hits.length >= max) return hits
        }
      }
      return hits
    },

    async readPages(paperId, from, to) {
      requirePaper(paperId)
      const pages = pagesOf(paperId)
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new ToolError('Give whole page numbers with 1 <= from <= to.')
      if (to - from + 1 > MAX_PAGES_PER_READ) throw new ToolError(`Read at most ${MAX_PAGES_PER_READ} pages per call.`)
      const maxPage = pages.reduce((m, p) => Math.max(m, p.page), 0)
      if (from > maxPage) throw new ToolError(`The paper has ${maxPage} pages.`)
      return { paper_id: paperId, pages: pages.filter((p) => p.page >= from && p.page <= to).map((p) => ({ page: p.page, text: p.text })) }
    },

    async getPaper(paperId) {
      const row = requirePaper(paperId)
      const read = await store.readPaper(paperId)
      const summary = await store.readSummary(paperId)
      const facets: Record<string, string[]> = {}
      for (const f of cache.facetRows()) if (f.paperId === paperId) (facets[f.facet] ??= []).push(f.value)
      return {
        paper_id: paperId,
        title: row.title,
        authors: row.authors_label,
        year: row.year,
        venue: row.venue,
        abstract: read.ok ? (read.value.abstract ?? null) : null,
        summary: summary?.ok ? Object.fromEntries(SUMMARY_KEYS.map((k) => [k, summary.value.fields[k].value])) : null,
        facets,
        pages: pagesOf(paperId).length
      }
    },

    async getCitations(paperId) {
      requirePaper(paperId)
      const detail = await map.relations(paperId)
      return { paper_id: paperId, cites: detail.cites.map(linked), cited_by: detail.citedBy.map(linked) }
    },

    async getNeighbours(paperId) {
      requirePaper(paperId)
      const detail = await map.relations(paperId)
      return { paper_id: paperId, similar: detail.similar.map((s) => ({ ...linked(s), score: s.score, reasons: s.reasons })) }
    }
  }
}
