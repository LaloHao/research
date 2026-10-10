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
  /** Pages of indexed text (0 for page-less web content). */
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
const SUMMARY_KEYS = ['tldr', 'problem', 'contribution', 'method', 'evaluation', 'results'] as const

const clamp = (n: number | undefined, fallback: number, max: number): number => Math.min(Math.max(Math.trunc(n ?? fallback), 1), max)

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
    if (!row || row.problem) throw new ToolError(`Unknown paper id "${id}". Use the ids given in the prompt or returned by the search tools.`)
    return row
  }
  const pagesOf = (id: string) => pagesFromChunks(cache.chunksFor(id))
  const linked = (p: { id: string; title: string; year: number | null }): LinkedOut => ({ paper_id: p.id, title: p.title, year: p.year })

  return {
    async searchText(query, paperId, limit) {
      if (paperId !== undefined) requirePaper(paperId)
      if (!/[\p{L}\p{N}]/u.test(query)) throw new ToolError('The query has no words to search for.')
      return cache.searchChunks(query, { paperId, limit: clamp(limit, 8, 20) }).map((h) => ({ paper_id: h.paperId, page: h.page, text: h.text.slice(0, SNIPPET_CHARS) }))
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
      // Web content has no pages: the whole text is one page-less block.
      if (pages.length > 0 && pages.every((p) => p.page === null)) return { paper_id: paperId, pages: pages.map((p) => ({ page: null, text: p.text })) }
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new ToolError('Give whole page numbers with 1 <= from <= to.')
      if (to - from + 1 > MAX_PAGES_PER_READ) throw new ToolError(`Read at most ${MAX_PAGES_PER_READ} pages per call.`)
      return { paper_id: paperId, pages: pages.filter((p) => p.page !== null && p.page >= from && p.page <= to).map((p) => ({ page: p.page, text: p.text })) }
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
        pages: pagesOf(paperId).filter((p) => p.page !== null).length
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
