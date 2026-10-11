import { z } from 'zod'
import type { TypedEdge } from './typedRelations'

/** OpenAlex work ids are stored bare ("W2741809807"), never as URLs. */
export const OPENALEX_ID = /^W\d+$/
const openalexId = z.string().regex(OPENALEX_ID)

/** The `citations` block of paper.yaml. */
export const CitationsSchema = z.object({
  source: z.literal('openalex'),
  fetched_at: z.string(),
  openalex_id: openalexId.optional(),
  /** Everything the paper cites, in the library or not. */
  references: z.array(openalexId).default([]),
  /** Total according to OpenAlex when fetched. */
  cited_by_count: z.number().int().nonnegative().optional(),
  /** No OpenAlex work could be matched unambiguously. */
  unresolved: z.boolean().optional()
})
export type Citations = z.infer<typeof CitationsSchema>

/** The `snowball` block of project.yaml: dismissed candidates never come back. */
export const SnowballSchema = z.object({ dismissed: z.array(openalexId).default([]) })
export type Snowball = z.infer<typeof SnowballSchema>

export const CITATIONS_STATUSES = ['none', 'ok', 'unresolved'] as const
export type CitationsStatus = (typeof CITATIONS_STATUSES)[number]

/** Why two papers are similar; the renderer turns each one into a sentence. */
export type SimilarityReason =
  | { kind: 'coupling'; shared: number }
  | { kind: 'cocitation'; by: number }
  | { kind: 'direct'; citing: string; cited: string }
  | { kind: 'facets'; shared: { facet: string; values: string[] }[] }
  | { kind: 'content'; cosine: number }
export const REASON_KINDS = ['coupling', 'cocitation', 'direct', 'facets', 'content'] as const

export interface LinkedPaper {
  id: string
  title: string
  year: number | null
}

export interface SimilarPaper extends LinkedPaper {
  score: number
  reasons: SimilarityReason[]
}

export interface RelationsDetail {
  citations: Citations | null
  /** Library papers this one cites. */
  cites: LinkedPaper[]
  /** Library papers that cite this one. */
  citedBy: LinkedPaper[]
  similar: SimilarPaper[]
  /** References that are not in the library. */
  externalReferences: number
}

/** Metadata of a work outside the library (cached in external_works). */
export interface ExternalWork {
  openalexId: string
  title: string | null
  year: number | null
  /** Display label such as "He & Zhu" or "Manning et al.". */
  authors: string
  /** Bare, lowercase DOI. */
  doi: string | null
  citedByCount: number | null
}

export const CANDIDATE_DIRECTIONS = ['references', 'citing', 'all'] as const
export type CandidateDirection = (typeof CANDIDATE_DIRECTIONS)[number]

export interface CandidateQuery {
  direction: CandidateDirection
  minCount: number
  /** Only candidates related to this library paper. */
  paperId?: string
}

export interface Candidate {
  openalexId: string
  work: ExternalWork | null
  /** How many library papers cite it. */
  citedByLibrary: number
  /** How many library papers it cites. */
  citesLibrary: number
  /** Library papers it is related to, either way. */
  paperIds: string[]
}

export interface CandidateList {
  candidates: Candidate[]
  /** Error code when the metadata of some candidates could not be fetched. */
  metadataError: string | null
}

export interface GraphNode {
  id: string
  title: string
  year: number | null
  citedByCount: number | null
  /** single/multi facet key → values. */
  facets: Record<string, string[]>
  /** Relevance to the thesis (1–5), when there is a relation. */
  thesisScore: number | null
}

export interface GraphData {
  nodes: GraphNode[]
  /** source cites target. */
  citations: { source: string; target: string }[]
  /** One per unordered pair, with the higher score of both directions. */
  similarities: { source: string; target: string; score: number; reasons: SimilarityReason[] }[]
  /** Suggested and confirmed typed relations (never rejected ones). */
  typed: TypedEdge[]
}

/** A single/multi facet of the extraction form. */
export interface FacetOption {
  key: string
  values: string[]
}

export interface FacetFilter {
  facet: string
  value: string
}

export const CHART_KINDS = ['bars', 'bubbles', 'years'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export type ChartQuery =
  | { kind: 'bars'; facet: string; onlyReviewed: boolean }
  | { kind: 'bubbles'; facet: string; facetY: string; onlyReviewed: boolean }
  | { kind: 'years'; facet: string; onlyReviewed: boolean }

export interface BarDatum {
  value: string
  reviewed: number
  unreviewed: number
}

export interface BubbleDatum {
  x: string
  y: string
  reviewed: number
  unreviewed: number
}

export interface YearDatum {
  year: number
  value: string
  reviewed: number
  unreviewed: number
}

export type ChartData =
  | { kind: 'bars'; facet: string; bars: BarDatum[] }
  | { kind: 'bubbles'; facet: string; facetY: string; xValues: string[]; yValues: string[]; cells: BubbleDatum[] }
  | { kind: 'years'; facet: string; years: YearDatum[] }

export interface ModelInfo {
  modelId: string
  /** False when this build has no local model runtime. */
  available: boolean
  state: 'missing' | 'ready'
  sizeBytes: number
  downloading: boolean
}

export type CountResult = { ok: true; count: number } | { ok: false; error: string }
