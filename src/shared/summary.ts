import { z } from 'zod'

export const FACET_KEY_PATTERN = /^[a-z][a-z0-9_]*$/
const key = z.string().regex(FACET_KEY_PATTERN)

export const SUMMARY_TEXT_FIELDS = ['tldr', 'problem', 'contribution', 'method', 'evaluation', 'results', 'future_work'] as const
export const SUMMARY_FIELD_KEYS = [...SUMMARY_TEXT_FIELDS, 'limitations', 'research_type'] as const
export type SummaryFieldKey = (typeof SUMMARY_FIELD_KEYS)[number]

export const RESEARCH_TYPES = ['solution_proposal', 'validation', 'evaluation', 'experience', 'philosophical', 'opinion'] as const
export const FIELD_STATUSES = ['generated', 'verified', 'edited'] as const
export type FieldStatus = (typeof FIELD_STATUSES)[number]

export const EvidenceSchema = z.object({
  quote: z.string().min(1),
  /** 1-based PDF page; null for page-less text (web pages). */
  page: z.number().int().positive().nullable(),
  /** Whether the quote was found in the extracted text. */
  found: z.boolean()
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const ProvenanceSchema = z.object({ model: z.string(), at: z.string(), prompt_version: z.number().int() })
export type Provenance = z.infer<typeof ProvenanceSchema>

const fieldOf = <T extends z.ZodType>(value: T) =>
  z.object({ value, status: z.enum(FIELD_STATUSES), evidence: z.array(EvidenceSchema).default([]), origin: ProvenanceSchema.optional() })

export const LimitationsSchema = z.object({ stated: z.array(z.string()), inferred: z.array(z.string()) })

export const SummaryFieldsSchema = z.object({
  tldr: fieldOf(z.string()),
  problem: fieldOf(z.string()),
  contribution: fieldOf(z.string()),
  method: fieldOf(z.string()),
  evaluation: fieldOf(z.string()),
  results: fieldOf(z.string()),
  limitations: fieldOf(LimitationsSchema),
  future_work: fieldOf(z.string()),
  research_type: fieldOf(z.enum(RESEARCH_TYPES))
})
export type SummaryFields = z.infer<typeof SummaryFieldsSchema>

export const SummaryFileSchema = z.looseObject({
  schema_version: z.literal(1),
  generated: z.object({
    model: z.string(),
    at: z.string(),
    cost_usd_est: z.number(),
    prompt_version: z.number().int(),
    language: z.string(),
    /** Set when the paper exceeded max_input_chars and only its beginning was sent (a forced run). */
    truncated: z.boolean().optional()
  }),
  fields: SummaryFieldsSchema
})
export type SummaryFile = z.infer<typeof SummaryFileSchema>

export const FACET_TYPES = ['single', 'multi', 'text', 'scale'] as const
const description = z.string().min(1)
export const FacetDefSchema = z.discriminatedUnion('type', [
  z.object({ key, type: z.literal('single'), description, values: z.array(key).min(1) }),
  z.object({ key, type: z.literal('multi'), description, values: z.array(key).min(1) }),
  z.object({ key, type: z.literal('text'), description }),
  z.object({ key, type: z.literal('scale'), description, min: z.number().int(), max: z.number().int() }).refine((f) => f.min <= f.max, {
    message: 'min must not be greater than max',
    path: ['max']
  })
])
export type FacetDef = z.infer<typeof FacetDefSchema>

export const ExtractionFormSchema = z.object({
  facets: z.array(FacetDefSchema),
  /** facet key → { proposed value → existing value }, learned from the user's mappings. */
  value_aliases: z.record(key, z.record(z.string(), key)).default({})
})
export type ExtractionForm = z.infer<typeof ExtractionFormSchema>

/** One facet in extraction.yaml; which value property is used depends on the facet type. */
export const FacetEntrySchema = z.object({
  values: z.array(z.string()).optional(),
  value: z.string().nullable().optional(),
  text: z.string().optional(),
  score: z.number().optional(),
  justification: z.string().optional(),
  proposed: z.array(z.string()).default([]),
  status: z.enum(FIELD_STATUSES),
  evidence: z.array(EvidenceSchema).default([]),
  origin: ProvenanceSchema.optional()
})
export type FacetEntry = z.infer<typeof FacetEntrySchema>

export const ThesisContextSchema = z.object({
  title: z.string().default(''),
  description: z.string().default(''),
  research_questions: z.array(z.object({ id: z.string().regex(/^RQ[1-9][0-9]*$/), text: z.string().min(1) })).default([]),
  /**
   * Highest research-question id ever assigned, so a new question never reuses the id of one that
   * was deleted (existing relations still refer to it by id). Never decreases. Excluded from
   * thesisHash: bumping it alone must not make summaries stale.
   */
  last_rq: z.number().int().min(0).default(0)
})
// `last_rq` is optional here (unlike the schema's own parsed output) so callers that only care about
// title/description/research_questions can build a ThesisContext literal without it.
export type ThesisContext = Omit<z.infer<typeof ThesisContextSchema>, 'last_rq'> & { last_rq?: number }

/** How one paper relates to the thesis in project.yaml. */
export const ThesisRelationSchema = z.object({
  text: z.string(),
  research_questions: z.array(z.string()),
  score: z.number().int().min(1).max(5),
  justification: z.string(),
  status: z.enum(FIELD_STATUSES),
  evidence: z.array(EvidenceSchema).default([]),
  origin: ProvenanceSchema.optional()
})
export type ThesisRelation = z.infer<typeof ThesisRelationSchema>

export const ExtractionFileSchema = z.looseObject({
  schema_version: z.literal(1),
  form_hash: z.string(),
  facets: z.record(z.string(), FacetEntrySchema),
  thesis_relation: ThesisRelationSchema.optional(),
  /** Hash of the thesis context the relation was generated against. */
  thesis_hash: z.string().optional()
})
export type ExtractionFile = z.infer<typeof ExtractionFileSchema>

export const LLM_MODELS = ['sonnet', 'haiku', 'opus'] as const
export type LlmModel = (typeof LLM_MODELS)[number]

/** Largest «Papers resumidos nuevos para sugerir» the app accepts from the renderer. */
export const AUTO_SUGGEST_FACETS_AFTER_MAX = 1000

export const DEFAULT_LLM_CONFIG = {
  model: 'sonnet' as const,
  auto_summarize: false,
  auto_suggest_relations: false,
  auto_suggest_facets: false,
  /** Up-to-date summaries added since the last facet suggestion run before the automatic trigger runs again. */
  auto_suggest_facets_after: 10,
  max_input_chars: 400000,
  budget: { per_operation_usd: 0.5, per_batch_usd: 10, per_month_usd: null as number | null, per_facet_suggestion_usd: 2, per_chat_message_usd: 0.5 }
}

/** Strict version (no fallback), used to validate edits from the UI. */
export const LlmConfigShape = z.object({
  model: z.enum(LLM_MODELS).default('sonnet'),
  auto_summarize: z.boolean().default(false),
  auto_suggest_relations: z.boolean().default(false),
  auto_suggest_facets: z.boolean().default(false),
  auto_suggest_facets_after: z.number().int().positive().default(10),
  max_input_chars: z.number().int().positive().default(400000),
  budget: z
    .object({
      per_operation_usd: z.number().positive().default(0.5),
      per_batch_usd: z.number().positive().default(10),
      per_month_usd: z.number().positive().nullable().default(null),
      /** The cap of one «Sugerir facetas» run, which reads the whole library. */
      per_facet_suggestion_usd: z.number().positive().default(2),
      /** One chat answer (its --max-budget-usd); counts for the monthly cap too. */
      per_chat_message_usd: z.number().positive().default(0.5)
    })
    .prefault({})
})

const B = DEFAULT_LLM_CONFIG.budget

/**
 * Lenient version for reading project.yaml: an invalid value falls back to its own default (the rest of the block is
 * kept) instead of making the file unreadable. ProjectStore keeps the invalid block on disk until it is rewritten on purpose.
 */
export const LlmConfigSchema = z
  .object({
    model: LlmConfigShape.shape.model.catch(DEFAULT_LLM_CONFIG.model),
    auto_summarize: LlmConfigShape.shape.auto_summarize.catch(DEFAULT_LLM_CONFIG.auto_summarize),
    auto_suggest_relations: LlmConfigShape.shape.auto_suggest_relations.catch(DEFAULT_LLM_CONFIG.auto_suggest_relations),
    auto_suggest_facets: LlmConfigShape.shape.auto_suggest_facets.catch(DEFAULT_LLM_CONFIG.auto_suggest_facets),
    auto_suggest_facets_after: LlmConfigShape.shape.auto_suggest_facets_after.catch(DEFAULT_LLM_CONFIG.auto_suggest_facets_after),
    max_input_chars: LlmConfigShape.shape.max_input_chars.catch(DEFAULT_LLM_CONFIG.max_input_chars),
    budget: z
      .object({
        per_operation_usd: z.number().positive().catch(B.per_operation_usd),
        per_batch_usd: z.number().positive().catch(B.per_batch_usd),
        per_month_usd: z.number().positive().nullable().catch(B.per_month_usd),
        per_facet_suggestion_usd: z.number().positive().catch(B.per_facet_suggestion_usd),
        per_chat_message_usd: z.number().positive().catch(B.per_chat_message_usd)
      })
      .catch(() => ({ ...B }))
  })
  .catch(() => structuredClone(DEFAULT_LLM_CONFIG))
export type LlmConfig = z.infer<typeof LlmConfigShape>

export const SUMMARY_STATUSES = ['none', 'generated', 'reviewed', 'stale', 'too_long', 'failed'] as const
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number]

export const COST_OPERATIONS = ['summarize', 'suggest_relations', 'suggest_facets', 'fill_facets', 'chat'] as const
export type CostOperation = (typeof COST_OPERATIONS)[number]

/** One line of costs/<device-id>.jsonl. */
export interface CostEntry {
  at: string
  /** The paper the call worked on; '' for a project-wide call (a facet suggestion run, a library chat answer). */
  paper_id: string
  batch_id: string | null
  model: string
  cost_usd: number
  operation: CostOperation
  /** The call was cut off (timeout, cancel) before it reported its cost: `cost_usd` is the per-operation cap. */
  estimated?: true
}

/** The `thesis` section has a single key, `relation`. */
export type Section = 'fields' | 'facets' | 'thesis'

/** A review item is a summary entry (Section) or a suggested typed relation ('relation', keyed by its id). */
export type ReviewSection = Section | 'relation'

/** One field, facet, thesis relation or suggested typed relation still waiting for the user's review. */
export interface ReviewItem {
  paperId: string
  title: string
  section: ReviewSection
  key: string
}

export interface SummaryPlan {
  count: number
  estimateUsd: number
  batchLimitUsd: number
}

export type FormInfo = { status: 'missing' } | { status: 'ok'; form: ExtractionForm } | { status: 'invalid'; errors: string[] }

/** What saving a changed extraction form would do: see SummaryService.formImpact. */
export interface FormImpact {
  staleCount: number
  removedValuesInUse: Array<{ facet: string; value: string; papers: number }>
}
