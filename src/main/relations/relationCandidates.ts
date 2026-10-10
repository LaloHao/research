import type { PaperAnalysis } from '../../shared/typedRelations'
import type { RelationRow } from '../cache/IndexCache'

/** Candidates the agent looks at per run: the papers most likely to be related (by citations, then similarity). */
export const MAX_CANDIDATES = 12

export type CandidateVia = 'cites' | 'cited_by' | 'similar'

export interface RelationCandidate {
  id: string
  title: string
  year: number | null
  via: CandidateVia[]
  /** Similarity score, when the paper is among the neighbours. */
  score: number | null
}

/** Built once per batch (or request) so each paper's candidates cost O(its own links), never O(library). */
export interface CandidateIndex {
  byId: Map<string, RelationRow>
  /** paper → library papers it cites. */
  cites: Map<string, string[]>
  /** paper → library papers that cite it. */
  citedBy: Map<string, string[]>
}

export function candidateIndex(rows: RelationRow[], edges: { citing: string; cited: string }[]): CandidateIndex {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const byOpenAlex = new Map(rows.flatMap((r) => (r.openalex_id ? [[r.openalex_id, r.id] as const] : [])))
  const cites = new Map<string, string[]>()
  const citedBy = new Map<string, string[]>()
  for (const e of edges) {
    const cited = byOpenAlex.get(e.cited)
    if (!cited || cited === e.citing || !byId.has(e.citing)) continue
    cites.set(e.citing, [...(cites.get(e.citing) ?? []), cited])
    citedBy.set(cited, [...(citedBy.get(cited) ?? []), e.citing])
  }
  return { byId, cites, citedBy }
}

export function relationCandidates(paperId: string, index: CandidateIndex, similar: { other: string; score: number }[], max = MAX_CANDIDATES): RelationCandidate[] {
  if (!index.byId.has(paperId)) return []
  const found = new Map<string, RelationCandidate>()
  const add = (id: string, via: CandidateVia, score: number | null = null): void => {
    const r = index.byId.get(id)
    if (!r || id === paperId) return
    const c = found.get(id) ?? { id, title: r.title, year: r.year, via: [], score: null }
    if (!c.via.includes(via)) c.via.push(via)
    if (score !== null) c.score = Math.max(c.score ?? 0, score)
    found.set(id, c)
  }
  for (const id of index.cites.get(paperId) ?? []) add(id, 'cites')
  for (const id of index.citedBy.get(paperId) ?? []) add(id, 'cited_by')
  for (const s of similar) add(s.other, 'similar', s.score)
  const linked = (c: RelationCandidate): number => (c.via.some((v) => v !== 'similar') ? 1 : 0)
  return [...found.values()].sort((a, b) => linked(b) - linked(a) || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id)).slice(0, max)
}

/** Papers whose last analysis already included `paperId`: that pair was looked at from the other side. */
export function coveredFrom(analyzed: Record<string, PaperAnalysis>, paperId: string): Set<string> {
  return new Set(Object.entries(analyzed).flatMap(([other, a]) => (other !== paperId && a.candidates.includes(paperId) ? [other] : [])))
}

/** The fingerprint check: worth analyzing again only when a candidate appears that the last analysis did not see. */
export function hasNewCandidates(candidateIds: string[], analysis: PaperAnalysis | undefined): boolean {
  return candidateIds.some((id) => !analysis?.candidates.includes(id))
}
