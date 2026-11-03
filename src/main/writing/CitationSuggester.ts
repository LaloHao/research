import type { Embedder } from '../embeddings/Embedder'
import { cosine } from '../relations/similarity'
import { bestSentence } from '../api/writingTools'
import { PassageFinder, queryTerms, type BestPassage } from './passages'

/**
 * Suggestions from the library for a sentence whose citation does not hold up: the papers most likely to support it
 * and the passage of each that does, found locally (no Claude). Candidates come from two sides, so it still works when
 * the local model is not on disk: the paper's vector against the sentence's (as `search_similar` does) and full-text
 * hits of the sentence's rarest terms. Each candidate's best window (PassageFinder) then says how well the paper
 * itself bears on the sentence, and the ranks are fused. These are hints to read, never verified claims.
 */

/** Papers taken from each side per sentence. */
export const SEMANTIC_CANDIDATES = 8
export const LEXICAL_CANDIDATES = 8
/** Terms of the sentence searched in full text (the longest, which are usually the rarest). */
export const LEXICAL_TERMS = 6
const HITS_PER_TERM = 40
/** Reciprocal-rank constant: small, since each list holds a handful of papers. */
const RRF_K = 10
const MAX_QUOTE_CHARS = 400

export interface SuggestablePaper {
  id: string
  title: string
  year: number | null
  /** Its text is indexed (without it there is no passage to show). */
  hasText: boolean
}

export interface CitationSuggesterDeps {
  /** The library's readable papers (not in the trash, no problem). */
  papers: () => SuggestablePaper[]
  /** Paper vectors made with that model (IndexCache.vectors). */
  vectors: (modelId: string) => Map<string, Float32Array>
  /** Full-text hits over the indexed chunks, best first (IndexCache.searchChunks). */
  searchChunks: (query: string, limit: number) => { paperId: string }[]
  /** A paper's indexed text in order (IndexCache.chunksFor). */
  chunks: (paperId: string) => { page: number | null; text: string }[]
  /** The local model, or null when it is not on disk. */
  embedder: () => Promise<Embedder | null>
}

export interface SuggestRequest {
  text: string
  /** Keys the sentence already cites. */
  exclude?: string[]
}

export interface CitationSuggestion {
  key: string
  title: string
  year: number | null
  page: number | null
  quote: string
  /** 0..1: the fused rank, relative to a paper first in every list. */
  score: number
}

export interface SentenceSuggestions {
  suggestions: CitationSuggestion[]
  /** The local model ranked the papers and passages too (else only their words did). */
  semantic: boolean
}

/** The longest terms first (ties in the sentence's order). */
function lexicalTerms(text: string): string[] {
  return queryTerms(text)
    .map((t, i) => [t, i] as const)
    .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
    .slice(0, LEXICAL_TERMS)
    .map(([t]) => t)
}

/** A verbatim prefix of `quote` of at most MAX_QUOTE_CHARS, cut at a space. */
function clip(quote: string): string {
  if (quote.length <= MAX_QUOTE_CHARS) return quote
  const cut = quote.lastIndexOf(' ', MAX_QUOTE_CHARS)
  return quote.slice(0, cut > MAX_QUOTE_CHARS / 2 ? cut : MAX_QUOTE_CHARS).trim()
}

const rankMap = (ids: string[]): Map<string, number> => new Map(ids.map((id, r) => [id, r]))

export class CitationSuggester {
  constructor(private readonly deps: CitationSuggesterDeps) {}

  /** Up to `perSentence` suggestions for each sentence, in order; a sentence without candidates gets none. */
  async suggest(sentences: SuggestRequest[], perSentence: number, signal?: AbortSignal): Promise<SentenceSuggestions[]> {
    const embedder = this.deps.embedder().catch((error: unknown) => {
      console.warn('suggest citations: the local model is unavailable, ranking by words only', error)
      return null
    })
    const finder = new PassageFinder({ chunks: this.deps.chunks, embedder: () => embedder })
    const papers = new Map(
      this.deps
        .papers()
        .filter((p) => p.hasText)
        .map((p) => [p.id, p])
    )
    const model = await embedder
    const vectors = model ? [...this.deps.vectors(model.modelId)].filter(([id]) => papers.has(id)) : []
    let queries: (Float32Array | null)[] = sentences.map(() => null)
    if (model && vectors.length > 0 && sentences.length > 0) {
      try {
        queries = await model.embed(
          sentences.map((s) => s.text),
          'query',
          signal
        )
      } catch (error) {
        signal?.throwIfAborted()
        console.warn('suggest citations: embedding the sentences failed, ranking by words only', error)
      }
    }
    const hitsOf = new Map<string, string[]>()
    const termHits = (term: string): string[] => {
      let ids = hitsOf.get(term)
      if (!ids) hitsOf.set(term, (ids = this.deps.searchChunks(term, HITS_PER_TERM).map((h) => h.paperId)))
      return ids
    }

    const out: SentenceSuggestions[] = []
    for (const [i, sentence] of sentences.entries()) {
      signal?.throwIfAborted()
      const exclude = new Set(sentence.exclude ?? [])
      const eligible = (id: string): boolean => papers.has(id) && !exclude.has(id)
      const q = queries[i] ?? null
      if (q) finder.primeClaim(sentence.text, q)

      const semanticIds = q
        ? vectors
            .filter(([id]) => eligible(id))
            .map(([id, v]) => [id, cosine(q, v)] as const)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, SEMANTIC_CANDIDATES)
            .map(([id]) => id)
        : []

      // Each term a paper's text holds weighs by how rare the term is in the library's hits.
      const lexical = new Map<string, number>()
      for (const term of lexicalTerms(sentence.text)) {
        const ids = termHits(term)
        if (ids.length === 0) continue
        const weight = Math.log(1 + HITS_PER_TERM / ids.length)
        for (const id of new Set(ids)) if (eligible(id)) lexical.set(id, (lexical.get(id) ?? 0) + weight)
      }
      const lexicalIds = [...lexical]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, LEXICAL_CANDIDATES)
        .map(([id]) => id)

      const candidates = [...new Set([...semanticIds, ...lexicalIds])]
      const found: { id: string; best: BestPassage }[] = []
      for (const id of candidates) {
        const best = await finder.best(id, sentence.text, signal)
        if (best && (best.coverage > 0 || best.similarity !== null)) found.push({ id, best })
      }

      const semantic = q !== null && (await finder.semantic())
      const lists: Map<string, number>[] = [rankMap(semanticIds), rankMap(lexicalIds)]
      lists.push(
        rankMap(
          found
            .filter((f) => f.best.coverage > 0)
            .sort((a, b) => b.best.coverage - a.best.coverage || a.id.localeCompare(b.id))
            .map((f) => f.id)
        )
      )
      if (semantic) {
        lists.push(
          rankMap(
            found
              .filter((f) => f.best.similarity !== null)
              .sort((a, b) => b.best.similarity! - a.best.similarity! || a.id.localeCompare(b.id))
              .map((f) => f.id)
          )
        )
      }
      const usedLists = semantic ? 4 : 2
      const top = (1 / RRF_K) * usedLists
      const terms = queryTerms(sentence.text).join(' ')
      const scored = found
        .map((f) => {
          const fused = lists.reduce((s, l) => (l.has(f.id) ? s + 1 / (RRF_K + l.get(f.id)!) : s), 0)
          return { ...f, score: fused / top }
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, perSentence)

      out.push({
        semantic,
        suggestions: scored.map(({ id, best, score }) => {
          const paper = papers.get(id)!
          return {
            key: id,
            title: paper.title,
            year: paper.year,
            page: best.passage.page,
            quote: clip(bestSentence(best.passage.text, terms || sentence.text)),
            score: Math.round(score * 1000) / 1000
          }
        })
      })
    }
    return out
  }
}
