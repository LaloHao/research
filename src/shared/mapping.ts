import { z } from 'zod'
import { AuthorSchema, PAPER_KINDS, type Author, type PaperKind } from './schemas'

/** A mapping's folder under mappings/: `<yyyymmdd>-<hhmmss>-<4 hex>`, like a conversation's id. */
export const MAPPING_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/
/** Derived from the record's best identifier (see dedup.ts), so one work imported on two machines gets one id. */
export const RECORD_ID = /^r[0-9a-f]{12}$/
export const SEARCH_ID = /^s[0-9a-f]{12}$/
export const DECISION_ID = /^d[0-9a-f]{12}$/
export const SCREENING_SUGGESTION_ID = /^g[0-9a-f]{12}$/
/** I<n> for inclusion and E<n> for exclusion; numbers are never reused (protocol `last_ids`). */
export const CRITERION_ID = /^[IE][1-9][0-9]*$/
export const RQ_ID = /^RQ[1-9][0-9]*$/
const PAPER_KEY = /^[a-z][a-z0-9]*$/

export const PHASES = ['title_abstract', 'full_text'] as const
export type Phase = (typeof PHASES)[number]

/** `none` is written only by «Deshacer» (back to undecided); `not_retrieved` only on full text. */
export const DECISIONS = ['include', 'exclude', 'uncertain', 'not_retrieved', 'none'] as const
export type DecisionValue = (typeof DECISIONS)[number]
/** What the user can choose in the screening queue. */
export const USER_DECISIONS = ['include', 'exclude', 'uncertain', 'not_retrieved'] as const
export type UserDecision = (typeof USER_DECISIONS)[number]
/** What Claude may suggest. */
export const SUGGESTED_DECISIONS = ['include', 'exclude', 'uncertain'] as const
export type SuggestedDecision = (typeof SUGGESTED_DECISIONS)[number]
/** `suggestion`: the user accepted Claude's suggestion as it was. */
export const DECIDERS = ['user', 'suggestion'] as const
export type Decider = (typeof DECIDERS)[number]
/** The only reviewer in 5a; a second, blind reviewer comes in 5b. */
export const MAIN_REVIEWER = 'main'

export const SEARCH_KINDS = ['openalex', 'import', 'snowball', 'library'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]
/** Searches of the first PRISMA column («Búsqueda en bases de datos»); the rest are «Otros métodos». */
export const DATABASE_KINDS: ReadonlySet<SearchKind> = new Set(['openalex', 'import'])
export const IMPORT_FORMATS = ['bibtex', 'ris', 'csv_scopus', 'csv_ieee', 'csv'] as const
export type ImportFormat = (typeof IMPORT_FORMATS)[number]
export const SNOWBALL_DIRECTIONS = ['backward', 'forward', 'both'] as const
export type SnowballDirection = (typeof SNOWBALL_DIRECTIONS)[number]
/** Why two records may be one work; `same_id` only arises when a sync joined records two machines made. */
export const DUPLICATE_REASONS = ['similar_title', 'same_title', 'conflicting_ids', 'same_id'] as const
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number]
/** OpenAlex work types offered as search filters. */
export const OPENALEX_TYPES = ['article', 'preprint', 'review', 'book', 'book-chapter', 'dissertation', 'report'] as const
export type OpenAlexType = (typeof OPENALEX_TYPES)[number]
/** Databases offered when importing (another name can be typed). */
export const DATABASE_NAMES = ['Scopus', 'IEEE Xplore', 'ACM Digital Library', 'Web of Science'] as const
/** Results an OpenAlex search fetches at most. */
export const SEARCH_CAP = { default: 500, max: 5000 } as const
/** Works one snowballing iteration looks up at most. */
export const SNOWBALL_CAP = 2000
export const MAX_REASON = 500
export const MAX_QUERY = 4000
export const MAX_TEXT = 2000

/**
 * Every object stored in the five files is loose, nested ones included, so keys a later version adds survive a
 * read-modify-write or a sync merge on an older machine. Input we own (the protocol draft) stays strict.
 */
const iso = z.string().min(1)
const count = z.number().int().nonnegative()

export const CriterionSchema = z.looseObject({ id: z.string().regex(CRITERION_ID), text: z.string().trim().min(1).max(MAX_TEXT) })
export type Criterion = z.infer<typeof CriterionSchema>
const QuestionSchema = z.looseObject({ id: z.string().regex(RQ_ID), text: z.string().trim().min(1).max(MAX_TEXT) })

const YearsSchema = z
  .looseObject({ from: z.number().int().nullable().default(null), to: z.number().int().nullable().default(null) })
  .refine((y) => y.from === null || y.to === null || y.from <= y.to, { message: 'from must not be after to', path: ['to'] })

/** The editable part of the protocol; earlier versions keep exactly this shape in `history`. */
export const ProtocolBodySchema = z
  .looseObject({
    title: z.string().trim().min(1).max(300),
    objective: z.string().max(MAX_TEXT * 3).default(''),
    research_questions: z.array(QuestionSchema).default([]),
    inclusion: z.array(CriterionSchema).default([]),
    exclusion: z.array(CriterionSchema).default([]),
    years: YearsSchema.prefault({}),
    publication_types: z.array(z.enum(PAPER_KINDS)).default([])
  })
  .superRefine((p, ctx) => {
    const ids = [...p.research_questions, ...p.inclusion, ...p.exclusion].map((c) => c.id)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'ids must be unique', path: ['inclusion'] })
    if (p.inclusion.some((c) => !c.id.startsWith('I'))) ctx.addIssue({ code: 'custom', message: 'inclusion ids start with I', path: ['inclusion'] })
    if (p.exclusion.some((c) => !c.id.startsWith('E'))) ctx.addIssue({ code: 'custom', message: 'exclusion ids start with E', path: ['exclusion'] })
  })
export type ProtocolBody = z.infer<typeof ProtocolBodySchema>

export const ProtocolFileSchema = z.looseObject({
  schema_version: z.literal(1),
  protocol: ProtocolBodySchema,
  /** Fixed in 5a; stored so a later stage can add or skip phases. */
  phases: z.array(z.enum(PHASES)).default([...PHASES]),
  /** Bumped by a change made once screening started; decisions and suggestions record the version they were made with. */
  version: z.number().int().positive(),
  /** Highest number ever given to a research question, an inclusion and an exclusion criterion: ids are never reused. */
  last_ids: z.looseObject({ rq: count.default(0), inclusion: count.default(0), exclusion: count.default(0) }).prefault({}),
  created_at: iso,
  updated_at: iso,
  /** Earlier versions, each with the date a later one replaced it. */
  history: z.array(z.looseObject({ version: z.number().int().positive(), replaced_at: iso, protocol: ProtocolBodySchema })).default([])
})
export type ProtocolFile = z.infer<typeof ProtocolFileSchema>

/** What «Guardar protocolo» sends: items keep their id, or have `null` to get the next free one. */
const DraftItemSchema = z.object({ id: z.string().max(10).nullable(), text: z.string().trim().min(1).max(MAX_TEXT) })
export const ProtocolDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  objective: z.string().max(MAX_TEXT * 3),
  research_questions: z.array(DraftItemSchema).max(50),
  inclusion: z.array(DraftItemSchema).max(50),
  exclusion: z.array(DraftItemSchema).max(50),
  years: z.object({ from: z.number().int().min(1800).max(2200).nullable(), to: z.number().int().min(1800).max(2200).nullable() }),
  publication_types: z.array(z.enum(PAPER_KINDS)).max(PAPER_KINDS.length)
})
export type ProtocolDraft = z.infer<typeof ProtocolDraftSchema>

export const SearchSchema = z.looseObject({
  id: z.string().regex(SEARCH_ID),
  kind: z.enum(SEARCH_KINDS),
  at: iso,
  machine: z.string().default(''),
  /** The database as the user named it (or OpenAlex); `library` for papers added from the library. */
  database: z.string().min(1).max(200),
  /** The exact search string, as typed in the app or as used in the database. */
  query: z.string().max(MAX_QUERY).nullable().default(null),
  filters: z.record(z.string(), z.string()).default({}),
  /** OpenAlex: the request URL, without the contact email or the API key. */
  request: z.string().nullable().default(null),
  file: z.string().max(260).nullable().default(null),
  format: z.enum(IMPORT_FORMATS).nullable().default(null),
  /** Records read (imports) or fetched (OpenAlex, snowballing). */
  count,
  /** OpenAlex's own count of results (or of works found while snowballing). */
  total: count.nullable().default(null),
  /** There were more results than the cap. */
  capped: z.boolean().default(false),
  /** Entries without a title. */
  skipped: count.default(0),
  origin: z
    .looseObject({ direction: z.enum(SNOWBALL_DIRECTIONS), from: z.array(z.string().regex(RECORD_ID)), iteration: z.number().int().positive() })
    .nullable()
    .default(null),
  discarded: z.looseObject({ at: iso, reason: z.string().trim().min(1).max(MAX_REASON), machine: z.string().default('') }).nullable().default(null)
})
export type Search = z.infer<typeof SearchSchema>
export const SearchesFileSchema = z.looseObject({ schema_version: z.literal(1), searches: z.array(SearchSchema).default([]) })
export type SearchesFile = z.infer<typeof SearchesFileSchema>

export const RecordIdentifiersSchema = z.looseObject({ doi: z.string().optional(), arxiv: z.string().optional(), openalex: z.string().optional() })
export type RecordIdentifiers = z.infer<typeof RecordIdentifiersSchema>

export const MappingRecordSchema = z.looseObject({
  id: z.string().regex(RECORD_ID),
  title: z.string().min(1),
  authors: z.array(AuthorSchema).default([]),
  year: z.number().int().nullable().default(null),
  venue: z.string().nullable().default(null),
  abstract: z.string().nullable().default(null),
  kind: z.enum(PAPER_KINDS).nullable().default(null),
  identifiers: RecordIdentifiersSchema.default({}),
  /** The searches that brought it. */
  sources: z.array(z.string().regex(SEARCH_ID)).min(1),
  /** The library paper this record is. */
  paper_id: z.string().regex(PAPER_KEY).nullable().default(null),
  /** A possible duplicate waiting for «Es el mismo» or «Son distintos». */
  duplicate_of: z.looseObject({ record: z.string().regex(RECORD_ID), reason: z.enum(DUPLICATE_REASONS) }).nullable().default(null),
  /** Confirmed duplicate of that record: it leaves the screening and counts as a duplicate. */
  merged_into: z.string().regex(RECORD_ID).nullable().default(null),
  distinct_from: z.array(z.string().regex(RECORD_ID)).default([]),
  added_at: iso,
  updated_at: iso
})
export type MappingRecord = z.infer<typeof MappingRecordSchema>
export const RecordsFileSchema = z.looseObject({ schema_version: z.literal(1), records: z.array(MappingRecordSchema).default([]) })
export type RecordsFile = z.infer<typeof RecordsFileSchema>

export const DecisionSchema = z.looseObject({
  id: z.string().regex(DECISION_ID),
  record: z.string().regex(RECORD_ID),
  phase: z.enum(PHASES),
  reviewer: z.string().regex(/^[a-z0-9_-]{1,40}$/).default(MAIN_REVIEWER),
  decision: z.enum(DECISIONS),
  criterion: z.string().regex(CRITERION_ID).nullable().default(null),
  note: z.string().max(MAX_REASON).nullable().default(null),
  by: z.enum(DECIDERS),
  suggestion: z.string().regex(SCREENING_SUGGESTION_ID).nullable().default(null),
  protocol_version: z.number().int().positive(),
  at: iso,
  machine: z.string().default(''),
  /** The decisions that were current for this record, phase and reviewer when this one was made. */
  replaces: z.array(z.string().regex(DECISION_ID)).default([]),
  /** «Deshacer»: the decision this one takes back. */
  undoes: z.string().regex(DECISION_ID).nullable().default(null)
})
export type Decision = z.infer<typeof DecisionSchema>
export const DecisionsFileSchema = z.looseObject({ schema_version: z.literal(1), decisions: z.array(DecisionSchema).default([]) })
export type DecisionsFile = z.infer<typeof DecisionsFileSchema>

export const ScreeningSuggestionSchema = z.looseObject({
  id: z.string().regex(SCREENING_SUGGESTION_ID),
  record: z.string().regex(RECORD_ID),
  phase: z.enum(PHASES),
  decision: z.enum(SUGGESTED_DECISIONS),
  criterion: z.string().regex(CRITERION_ID).nullable().default(null),
  justification: z.string().min(1).max(MAX_TEXT),
  quote: z.string().max(MAX_TEXT).nullable().default(null),
  page: z.number().int().positive().nullable().default(null),
  /** The quote was found in the title and abstract (or in the paper's pages). */
  found: z.boolean().default(false),
  model: z.string(),
  at: iso,
  protocol_version: z.number().int().positive(),
  prompt_version: z.number().int()
})
export type ScreeningSuggestion = z.infer<typeof ScreeningSuggestionSchema>
export const SuggestionsFileSchema = z.looseObject({ schema_version: z.literal(1), suggestions: z.array(ScreeningSuggestionSchema).default([]) })
export type SuggestionsFile = z.infer<typeof SuggestionsFileSchema>

/** A work found by a search or read from an export, before it becomes a record. */
export interface WorkCandidate {
  title: string
  authors: Author[]
  year: number | null
  venue: string | null
  abstract: string | null
  kind: PaperKind | null
  identifiers: RecordIdentifiers
  /** Set when the candidate is a library paper («Desde la biblioteca»). */
  paperId?: string | null
}

/**
 * A criterion's text as worded in protocol `version` (the decision's or suggestion's `protocol_version`), so a later
 * change of wording never relabels an old decision. Without a version, or when that version does not name it, the
 * current protocol, then the latest earlier version that had it (a decision made before it was removed).
 */
export function criterionText(file: ProtocolFile, id: string, version?: number): string | null {
  const find = (body: ProtocolBody): string | null => [...body.inclusion, ...body.exclusion].find((c) => c.id === id)?.text ?? null
  if (version !== undefined) {
    const bodies = version === file.version ? [file.protocol] : file.history.filter((h) => h.version === version).map((h) => h.protocol)
    for (const body of bodies) {
      const text = find(body)
      if (text !== null) return text
    }
  }
  const current = find(file.protocol)
  if (current !== null) return current
  for (const h of [...file.history].sort((a, b) => b.version - a.version)) {
    const text = find(h.protocol)
    if (text !== null) return text
  }
  return null
}

/** Excluding names a current exclusion criterion; including names a current inclusion criterion or none; the rest name none. */
export function criterionFits(file: ProtocolFile, decision: DecisionValue, criterion: string | null): boolean {
  if (decision === 'exclude') return criterion !== null && file.protocol.exclusion.some((c) => c.id === criterion)
  if (decision === 'include') return criterion === null || file.protocol.inclusion.some((c) => c.id === criterion)
  return criterion === null
}

export const PHASE_STATES = ['pending', 'include', 'exclude', 'uncertain', 'not_retrieved', 'conflict'] as const
export type PhaseState = (typeof PHASE_STATES)[number]

export interface ConflictOption {
  decisionId: string
  decision: DecisionValue
  criterion: string | null
  by: Decider
  at: string
  machine: string
}

/** A record's state in one phase, from its current decisions. */
export interface PhaseView {
  state: PhaseState
  criterion: string | null
  /** The current decision (what «Deshacer» takes back); null when pending or in conflict. */
  decisionId: string | null
  by: Decider | null
  at: string | null
  protocolVersion: number | null
  /** Made with an earlier version of the protocol. */
  outdated: boolean
  /** The disagreeing decisions of a conflict. */
  options: ConflictOption[]
}

export const EMPTY_PHASE_VIEW: PhaseView = { state: 'pending', criterion: null, decisionId: null, by: null, at: null, protocolVersion: null, outdated: false, options: [] }

export interface SuggestionView {
  id: string
  decision: SuggestedDecision
  criterion: string | null
  justification: string
  quote: string | null
  page: number | null
  found: boolean
  model: string
  at: string
  /** Made with an earlier version of the protocol. */
  outdated: boolean
}

export const PRISMA_COLUMNS = ['databases', 'other'] as const
export type PrismaColumnKey = (typeof PRISMA_COLUMNS)[number]

/** One record as the index keeps it and the screening queue shows it. */
export interface MappingRecordRow {
  id: string
  title: string
  authors_label: string
  /** Every author, "Given Family", comma separated. */
  authors: string
  year: number | null
  venue: string | null
  abstract: string | null
  kind: PaperKind | null
  doi: string | null
  arxiv: string | null
  openalex: string | null
  paper_id: string | null
  sources: string[]
  /** Not merged into another record, and brought by at least one search that was not discarded. */
  active: boolean
  column: PrismaColumnKey
  /** A possible duplicate waiting for a decision (stored, or found after a sync). */
  duplicate: { of: string; reason: DuplicateReason } | null
  title_abstract: PhaseView
  full_text: PhaseView
  suggestions: Record<Phase, SuggestionView | null>
  added_at: string
}

export interface RecordBrief {
  id: string
  title: string
  authors_label: string
  year: number | null
  venue: string | null
  doi: string | null
}

export interface DuplicatePair {
  record: RecordBrief
  other: RecordBrief
  reason: DuplicateReason
}

export interface ScreeningConflict {
  record: RecordBrief
  phase: Phase
  options: ConflictOption[]
}

/** Active records per phase and state (full text: only records included on title and abstract). */
export type ScreeningCounts = Record<Phase, Record<PhaseState, number>>

export const QUEUE_FILTERS = ['pending', 'uncertain', 'include', 'exclude', 'not_retrieved', 'conflict', 'all'] as const
export type QueueFilter = (typeof QUEUE_FILTERS)[number]

export interface QueueQuery {
  phase: Phase
  filter: QueueFilter
}

/** One source box of the PRISMA diagram: a database (by name), or every snowballing or library search together. */
export interface PrismaSource {
  kind: SearchKind
  database: string
  count: number
}

export interface PrismaColumn {
  identified: PrismaSource[]
  duplicates: number
  screened: number
  excludedScreening: number
  pendingScreening: number
  sought: number
  notRetrieved: number
  assessed: number
  excludedFullText: { criterion: string; count: number }[]
  pendingFullText: number
  included: number
}

export interface PrismaCounts {
  databases: PrismaColumn
  other: PrismaColumn
  included: number
}

export interface MappingSummary {
  id: string
  title: string
  records: number
  pending: number
  included: number
  /** An error code when a file of the mapping does not read. */
  problem: string | null
  updatedAt: string | null
}

export interface MappingView {
  id: string
  protocol: ProtocolFile
  /** Newest first. */
  searches: Search[]
  prisma: PrismaCounts
  counts: ScreeningCounts
  duplicates: DuplicatePair[]
  conflicts: ScreeningConflict[]
  /** Some decision exists: a change to the protocol creates a new version. */
  screeningStarted: boolean
}

export interface DecideRequest {
  recordId: string
  phase: Phase
  decision: UserDecision
  criterion: string | null
  /** «Aceptar sugerencia»: the suggestion accepted as it is. */
  suggestionId: string | null
}

export interface ImportSource {
  database: string
  query: string
}

export interface ImportOutcome {
  read: number
  added: number
  /** Already records of the mapping (they only gain this search as a source). */
  merged: number
  /** New records that are library papers. */
  linked: number
  doubtful: number
  skipped: number
}

export interface OpenAlexSearchRequest {
  query: string
  fromYear: number | null
  toYear: number | null
  types: OpenAlexType[]
  cap: number
}

export interface ScreeningPlan {
  phase: Phase
  /** Records Claude would look at. */
  count: number
  calls: number
  estimateUsd: number
  perCallUsd: number
  batchCapUsd: number
  monthSpentUsd: number
  monthCapUsd: number | null
  /** Full text: included records whose paper has no text yet (skipped). */
  withoutText: number
}

export interface IngestPlan {
  count: number
  /** «Resumir automáticamente al agregar» is on: each new paper is also summarized. */
  autoSummarize: boolean
  estimateUsd: number
}
