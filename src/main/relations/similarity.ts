import type { SimilarityReason } from '../../shared/relations'

/** Fixed weights of the combined score; tuned with `pnpm eval:similarity`. They add up to 1. */
export const WEIGHTS = { content: 0.4, coupling: 0.25, facets: 0.2, cocitation: 0.1, direct: 0.05 } as const
export type SignalName = keyof typeof WEIGHTS
export type Weights = Record<SignalName, number>

/** Neighbours kept per paper. */
export const TOP_K = 10

/** e5 cosines of any two scientific texts already sit around 0.7–0.8: below this floor content adds nothing. */
export const CONTENT_FLOOR = 0.75

export interface PaperSignals {
  id: string
  openalexId: string | null
  references: ReadonlySet<string>
  /** single/multi facet key → values. */
  facets: ReadonlyMap<string, ReadonlySet<string>>
  vector: Float32Array | null
}

export interface PairSignals {
  coupling: number
  sharedRefs: number
  cocitation: number
  cocitedBy: number
  direct: { citing: string; cited: string } | null
  facets: number
  sharedFacets: { facet: string; values: string[] }[]
  /** null when either paper has no vector. */
  cosine: number | null
}

export interface ScoredPair {
  a: string
  b: string
  score: number
  reasons: SimilarityReason[]
}

const EMPTY: ReadonlySet<string> = new Set()
const round = (n: number, digits: number): number => Math.round(n * 10 ** digits) / 10 ** digits

function intersection(x: ReadonlySet<string>, y: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const v of x) if (y.has(v)) out.push(v)
  return out
}

export function jaccard(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 && y.size === 0) return 0
  const inter = intersection(x, y).length
  return inter / (x.size + y.size - inter)
}

export function cosine(x: Float32Array, y: Float32Array): number {
  let dot = 0
  let nx = 0
  let ny = 0
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    dot += x[i] * y[i]
    nx += x[i] * x[i]
    ny += y[i] * y[i]
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0
}

export function contentValue(cos: number): number {
  return Math.max(0, Math.min(1, (cos - CONTENT_FLOOR) / (1 - CONTENT_FLOOR)))
}

/** For each library paper, the library papers that cite it (matched by OpenAlex id). */
export function internalCiters(papers: PaperSignals[]): Map<string, Set<string>> {
  const byOpenAlex = new Map(papers.flatMap((p) => (p.openalexId ? [[p.openalexId, p.id] as const] : [])))
  const citers = new Map<string, Set<string>>()
  for (const p of papers) {
    for (const ref of p.references) {
      const cited = byOpenAlex.get(ref)
      if (!cited || cited === p.id) continue
      const set = citers.get(cited) ?? new Set<string>()
      set.add(p.id)
      citers.set(cited, set)
    }
  }
  return citers
}

export function pairSignals(a: PaperSignals, b: PaperSignals, citers: ReadonlyMap<string, ReadonlySet<string>>): PairSignals {
  const sharedRefs = intersection(a.references, b.references).length
  const ca = citers.get(a.id) ?? EMPTY
  const cb = citers.get(b.id) ?? EMPTY
  const cocitedBy = intersection(ca, cb).length
  const direct =
    b.openalexId && a.references.has(b.openalexId)
      ? { citing: a.id, cited: b.id }
      : a.openalexId && b.references.has(a.openalexId)
        ? { citing: b.id, cited: a.id }
        : null
  const perFacet: number[] = []
  const sharedFacets: { facet: string; values: string[] }[] = []
  for (const [facet, values] of a.facets) {
    const other = b.facets.get(facet)
    if (!values.size || !other?.size) continue
    perFacet.push(jaccard(values, other))
    const shared = intersection(values, other).sort()
    if (shared.length) sharedFacets.push({ facet, values: shared })
  }
  // Sorted, so the reasons of (a, b) and (b, a) are identical.
  sharedFacets.sort((x, y) => x.facet.localeCompare(y.facet))
  return {
    coupling: jaccard(a.references, b.references),
    sharedRefs,
    cocitation: cocitedBy ? cocitedBy / Math.sqrt(ca.size * cb.size) : 0,
    cocitedBy,
    direct,
    facets: perFacet.length ? perFacet.reduce((s, v) => s + v, 0) / perFacet.length : 0,
    sharedFacets,
    cosine: a.vector && b.vector ? cosine(a.vector, b.vector) : null
  }
}

/** Weighted mean of the signals in [0, 1]; without a cosine the content weight is left out and the rest renormalized. */
export function combine(s: PairSignals, weights: Weights = WEIGHTS): number {
  const values: Record<SignalName, number> = {
    content: s.cosine === null ? 0 : contentValue(s.cosine),
    coupling: s.coupling,
    facets: s.facets,
    cocitation: s.cocitation,
    direct: s.direct ? 1 : 0
  }
  const names = (Object.keys(weights) as SignalName[]).filter((n) => n !== 'content' || s.cosine !== null)
  const totalWeight = names.reduce((t, n) => t + weights[n], 0)
  if (totalWeight === 0) return 0
  return names.reduce((sum, n) => sum + weights[n] * values[n], 0) / totalWeight
}

export function reasons(s: PairSignals): SimilarityReason[] {
  const out: SimilarityReason[] = []
  if (s.cosine !== null && contentValue(s.cosine) > 0) out.push({ kind: 'content', cosine: round(s.cosine, 2) })
  if (s.sharedRefs) out.push({ kind: 'coupling', shared: s.sharedRefs })
  if (s.cocitedBy) out.push({ kind: 'cocitation', by: s.cocitedBy })
  if (s.direct) out.push({ kind: 'direct', ...s.direct })
  if (s.sharedFacets.length) out.push({ kind: 'facets', shared: s.sharedFacets })
  return out
}

function byScore(x: ScoredPair, y: ScoredPair): number {
  return y.score - x.score || x.b.localeCompare(y.b)
}

/** Keeps a list bounded while it grows: trims to k whenever it doubles. */
function pushTopK(list: ScoredPair[], item: ScoredPair, k: number): void {
  list.push(item)
  if (list.length >= 2 * k) {
    list.sort(byScore)
    list.length = k
  }
}

function scored(a: PaperSignals, b: PaperSignals, citers: ReadonlyMap<string, ReadonlySet<string>>, weights: Weights): ScoredPair | null {
  const s = pairSignals(a, b, citers)
  const score = round(combine(s, weights), 4)
  return score > 0 ? { a: a.id, b: b.id, score, reasons: reasons(s) } : null
}

/** One paper's row: its k best neighbours. O(n). */
export function neighboursOf(
  target: PaperSignals,
  papers: PaperSignals[],
  citers: ReadonlyMap<string, ReadonlySet<string>>,
  k: number = TOP_K,
  weights: Weights = WEIGHTS
): ScoredPair[] {
  const list: ScoredPair[] = []
  for (const other of papers) {
    if (other.id === target.id) continue
    const pair = scored(target, other, citers, weights)
    if (pair) pushTopK(list, pair, k)
  }
  return list.sort(byScore).slice(0, k)
}

/** Every row, by brute force (fine for a few thousand papers). */
export function neighbours(papers: PaperSignals[], k: number = TOP_K, weights: Weights = WEIGHTS): ScoredPair[] {
  const citers = internalCiters(papers)
  return papers.flatMap((p) => neighboursOf(p, papers, citers, k, weights))
}

/**
 * The rows to rewrite after one paper changed, was added (`previous` null) or was removed (missing from `papers`).
 * Recomputed in full: the paper's own row and the rows of the library papers it cites before or after the change
 * (their co-citation changed). Every other row only re-scores its pairs with those papers; it is recomputed in full
 * only when one of them got a lower score (or none) in a full row, because then an unseen paper may take its place.
 * O(n · affected) instead of O(n²). An empty row means "no neighbours".
 */
export function updateNeighbours(
  papers: PaperSignals[],
  previous: PaperSignals | null,
  changedId: string,
  rows: ReadonlyMap<string, ScoredPair[]>,
  k: number = TOP_K,
  weights: Weights = WEIGHTS
): Map<string, ScoredPair[]> {
  const citers = internalCiters(papers)
  const byId = new Map(papers.map((p) => [p.id, p]))
  const byOpenAlex = new Map(papers.flatMap((p) => (p.openalexId ? [[p.openalexId, p.id] as const] : [])))
  const current = byId.get(changedId) ?? null
  const affected = new Set<string>([changedId])
  for (const refs of [current?.references, previous?.references]) {
    for (const ref of refs ?? []) {
      const id = byOpenAlex.get(ref)
      if (id) affected.add(id)
    }
  }
  const out = new Map<string, ScoredPair[]>()
  for (const id of affected) {
    const paper = byId.get(id)
    out.set(id, paper ? neighboursOf(paper, papers, citers, k, weights) : [])
  }
  for (const x of papers) {
    if (affected.has(x.id)) continue
    const row = rows.get(x.id) ?? []
    const fresh = [...affected].flatMap((id) => {
      const paper = byId.get(id)
      const pair = paper ? scored(x, paper, citers, weights) : null
      return pair ? [pair] : []
    })
    const touched = row.filter((e) => affected.has(e.b))
    if (touched.length === 0 && fresh.length === 0) continue
    const lowered = touched.some((e) => {
      const now = fresh.find((f) => f.b === e.b)
      return !now || now.score < e.score
    })
    if (lowered && row.length >= k) {
      out.set(x.id, neighboursOf(x, papers, citers, k, weights))
      continue
    }
    out.set(x.id, [...row.filter((e) => !affected.has(e.b)), ...fresh].sort(byScore).slice(0, k))
  }
  return out
}
