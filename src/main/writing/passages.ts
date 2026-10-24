import { normalizeForMatch } from '../../shared/textMatch'
import type { Embedder } from '../embeddings/Embedder'
import { pagesFromChunks, stripReferences, type PageText } from '../summary/paperText'

/**
 * The passages of a cited paper most likely to bear on a claim, found by the app before Claude is asked: a BM25 rank
 * over the paper's text and, when the local multilingual model is on disk, a semantic rank (a Spanish sentence citing
 * an English paper shares few words with it), fused by reciprocal rank. Claude then judges the claim on these passages
 * in one structured call, which costs far less than letting an agent search each paper with tools.
 */

export interface Passage {
  page: number | null
  text: string
}

/** Characters per window; a window ends at whitespace. */
export const WINDOW_CHARS = 800
/** Windows of one paper embedded at most; a longer text (a book) is ranked by its words only. */
const MAX_EMBED_WINDOWS = 400
const EMBED_BATCH = 32
const RRF_K = 60
const BM25_K1 = 1.2
const BM25_B = 0.75
const STEM_CHARS = 6

/** Function words of English and Spanish, which say nothing about a claim. */
const STOPWORDS = new Set(
  (
    'the and for are was were that this with from these those their there which into than then also such been have has had ' +
    'not but can may our its they them more most other some what when where while will would could should about between ' +
    'los las del una unos unas por para con que como más pero sus sobre entre este esta estos estas ese esa esos esas ' +
    'son fue han sin ser hay muy cual cuales donde cuando también otro otra otros otras puede pueden desde hasta sino'
  ).split(' ')
)

const fold = (s: string): string => normalizeForMatch(s).normalize('NFD').replace(/\p{M}/gu, '')

/** The claim's content words, folded and cut to a crude stem (so "detection" meets "detect"). */
export function queryTerms(text: string): string[] {
  const words = fold(text.replace(/\\[A-Za-z]+\*?/g, ' ')).match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)).map(stem))]
}

const stem = (w: string): string => w.slice(0, STEM_CHARS)

/** A page's text cut into ~WINDOW_CHARS windows at whitespace. */
export function windowsOf(pages: PageText[]): Passage[] {
  const out: Passage[] = []
  for (const p of pages) {
    const text = p.text.replace(/\s+/g, ' ').trim()
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + WINDOW_CHARS, text.length)
      if (end < text.length) {
        const space = text.lastIndexOf(' ', end)
        if (space > start + WINDOW_CHARS / 2) end = space
      }
      out.push({ page: p.page, text: text.slice(start, end).trim() })
      start = end
    }
  }
  return out.filter((w) => w.text.length > 0)
}

/** BM25 of each window for `terms` (each window's own words stemmed), 0 for a window without any of them. */
export function bm25(windows: Passage[], terms: string[]): number[] {
  const docs = windows.map((w) => {
    const counts = new Map<string, number>()
    const words = fold(w.text).match(/[\p{L}\p{N}]+/gu) ?? []
    for (const word of words) {
      const s = stem(word)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return { counts, length: words.length }
  })
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1)
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.counts.has(t)).length]))
  return docs.map((d) =>
    terms.reduce((score, t) => {
      const tf = d.counts.get(t) ?? 0
      if (tf === 0) return score
      const n = df.get(t)!
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      return score + (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / Math.max(avg, 1)))
    }, 0)
  )
}

/** Ranks (0 = best) of the windows with a positive score; the others are left out. */
function ranks(scores: number[]): Map<number, number> {
  const order = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
  return new Map(order.map(([, i], r) => [i, r]))
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

interface PaperIndex {
  windows: Passage[]
  /** null: not embedded (no model, too long, or the model failed). */
  vectors: Float32Array[] | null
}

export interface PassageFinderDeps {
  /** The paper's indexed text in order (IndexCache.chunksFor). */
  chunks: (paperId: string) => { page: number | null; text: string }[]
  /** The local model, or null when it is not on disk. */
  embedder: () => Promise<Embedder | null>
}

/** Passages per (claim, paper) for one check; each paper is cut (and embedded) once per check. */
export class PassageFinder {
  private readonly papers = new Map<string, Promise<PaperIndex>>()
  private embedder: Promise<Embedder | null> | null = null

  constructor(private readonly deps: PassageFinderDeps) {}

  /**
   * The `n` best windows of `paperId` for `claim`, in the paper's order. When fewer than `n` windows match at all, the
   * paper's first window (its abstract, usually) fills in, so Claude always sees something of the paper.
   */
  async find(paperId: string, claim: string, n: number, signal?: AbortSignal): Promise<Passage[]> {
    const index = await this.index(paperId, signal)
    if (index.windows.length === 0) return []
    const lexical = ranks(bm25(index.windows, queryTerms(claim)))
    let semantic = new Map<number, number>()
    if (index.vectors) {
      const q = await this.embedClaim(claim, signal)
      if (q) semantic = ranks(index.vectors.map((v) => dot(q, v) + 1))
    }
    const fused = new Map<number, number>()
    for (const [i, r] of lexical) fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r))
    for (const [i, r] of semantic) fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + r))
    const picked = [...fused]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, n)
      .map(([i]) => i)
    if (picked.length < n && !picked.includes(0)) picked.push(0)
    return picked.sort((a, b) => a - b).map((i) => index.windows[i])
  }

  private index(paperId: string, signal?: AbortSignal): Promise<PaperIndex> {
    let p = this.papers.get(paperId)
    if (!p) {
      p = this.build(paperId, signal)
      this.papers.set(paperId, p)
    }
    return p
  }

  private async build(paperId: string, signal?: AbortSignal): Promise<PaperIndex> {
    const windows = windowsOf(stripReferences(pagesFromChunks(this.deps.chunks(paperId))))
    const embedder = windows.length > 0 && windows.length <= MAX_EMBED_WINDOWS ? await this.model() : null
    if (!embedder) return { windows, vectors: null }
    try {
      const vectors: Float32Array[] = []
      for (let i = 0; i < windows.length; i += EMBED_BATCH) {
        vectors.push(...(await embedder.embed(windows.slice(i, i + EMBED_BATCH).map((w) => w.text), 'passage', signal)))
      }
      return { windows, vectors }
    } catch (error) {
      signal?.throwIfAborted()
      console.warn(`cite check: embedding ${paperId} failed, ranking by its words only`, error)
      return { windows, vectors: null }
    }
  }

  private async embedClaim(claim: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const embedder = await this.model()
    if (!embedder) return null
    try {
      const [v] = await embedder.embed([claim], 'query', signal)
      return v ?? null
    } catch (error) {
      signal?.throwIfAborted()
      console.warn('cite check: embedding a claim failed, ranking by its words only', error)
      return null
    }
  }

  private model(): Promise<Embedder | null> {
    this.embedder ??= this.deps.embedder().catch((error: unknown) => {
      console.warn('cite check: the local model is unavailable, ranking by words only', error)
      return null
    })
    return this.embedder
  }
}
