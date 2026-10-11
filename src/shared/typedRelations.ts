import { z } from 'zod'

export const RELATION_TYPES = ['extends', 'uses_method_of', 'compares_with', 'contradicts', 'replicates', 'same_problem'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** No direction: `from`/`to` are stored in alphabetical order and the UI shows none. */
export const SYMMETRIC_TYPES: ReadonlySet<RelationType> = new Set<RelationType>(['compares_with', 'same_problem'])

/** Longest justification the user can save (renderer textarea and main-process validation). */
export const MAX_JUSTIFICATION = 2000

export const RELATION_STATUSES = ['suggested', 'confirmed', 'rejected'] as const
export type RelationStatus = (typeof RELATION_STATUSES)[number]

/** `<a>__<b>__<type>` with a < b; paper keys never contain `_`. */
export const RELATION_ID = new RegExp(`^[a-z][a-z0-9]*__[a-z][a-z0-9]*__(${RELATION_TYPES.join('|')})$`)

const paperKey = z.string().regex(/^[a-z][a-z0-9]*$/)

export function relationId(a: string, b: string, type: RelationType): string {
  const [x, y] = a < b ? [a, b] : [b, a]
  return `${x}__${y}__${type}`
}

/** `from`/`to` as stored: symmetric types in alphabetical order, the others as given. */
export function orient(from: string, to: string, type: RelationType): { from: string; to: string } {
  return SYMMETRIC_TYPES.has(type) && from > to ? { from: to, to: from } : { from, to }
}

export function otherEnd(r: { from: string; to: string }, paperId: string): string {
  return r.from === paperId ? r.to : r.from
}

export const RelationEvidenceSchema = z.object({
  paper: paperKey,
  /** 1-based page; null for page-less text (web pages). */
  page: z.number().int().positive().nullable(),
  quote: z.string().min(1),
  /** Whether the quote was found in that paper's extracted text. */
  found: z.boolean()
})
export type RelationEvidence = z.infer<typeof RelationEvidenceSchema>

export const RelationOriginSchema = z.object({
  model: z.string(),
  at: z.string(),
  prompt_version: z.number().int(),
  /** The paper whose analysis suggested it: only a new analysis of that paper replaces it while unreviewed. */
  paper: paperKey.optional()
})
export type RelationOrigin = z.infer<typeof RelationOriginSchema>

/** Loose: keys added by a later version survive a round trip (and an automatic conflict resolution). */
export const TypedRelationSchema = z
  .looseObject({
    id: z.string().regex(RELATION_ID),
    type: z.enum(RELATION_TYPES),
    from: paperKey,
    to: paperKey,
    status: z.enum(RELATION_STATUSES),
    /** True once the user changed the type, the direction or the justification. */
    edited: z.boolean().default(false),
    justification: z.string(),
    evidence: z.array(RelationEvidenceSchema).default([]),
    origin: RelationOriginSchema.optional(),
    /** Every id this entry had before the user changed its type: those ids are never suggested again. */
    replaced: z.array(z.string().regex(RELATION_ID)).optional(),
    updated_at: z.string()
  })
  .refine((r) => r.from !== r.to && r.id === relationId(r.from, r.to, r.type), { message: 'id does not match from, to and type', path: ['id'] })
export type TypedRelation = z.infer<typeof TypedRelationSchema>

/** The candidates a paper was last analyzed with (its fingerprint); a new candidate makes it worth analyzing again. */
export const PaperAnalysisSchema = z.object({ candidates: z.array(paperKey), at: z.string() })
export type PaperAnalysis = z.infer<typeof PaperAnalysisSchema>

/** relations.yaml at the project root; loose so a later version's keys survive a round trip. */
export const RelationsFileSchema = z.looseObject({
  schema_version: z.literal(1),
  relations: z.array(TypedRelationSchema).default([]),
  /** paper key → the candidates its last analysis looked at. Versioned (not in .cache/) so a rebuilt cache never re-spends. */
  analyzed: z.record(z.string().regex(/^[a-z][a-z0-9]*$/), PaperAnalysisSchema).default({})
})
export type RelationsFile = z.infer<typeof RelationsFileSchema>

export type RelationsFileState = { status: 'ok' } | { status: 'missing' } | { status: 'conflict' } | { status: 'invalid'; message: string }

/** A relation as the Relations tab shows it, with the paper at the other end. */
export interface RelationView extends TypedRelation {
  other: { id: string; title: string; year: number | null }
}

export interface PaperRelations {
  suggested: RelationView[]
  confirmed: RelationView[]
  rejected: RelationView[]
  /** Candidates the next suggestion would look at (citations and similar papers). */
  candidates: number
  /** The candidates changed since the last analysis (or there was none). */
  needsAnalysis: boolean
  file: RelationsFileState
}

/** One review decision, kept in the main process behind an undo token; undoing it puts `before` back. */
export interface RelationChange {
  before: TypedRelation
  after: TypedRelation
}

export interface RelationPlan {
  count: number
  estimateUsd: number
  batchLimitUsd: number
}

/** A typed relation as a graph edge (rejected ones are never edges). */
export interface TypedEdge {
  id: string
  source: string
  target: string
  type: RelationType
  status: 'suggested' | 'confirmed'
  directed: boolean
}
