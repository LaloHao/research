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
    language: z.string()
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
  z.object({ key, type: z.literal('scale'), description, min: z.number().int(), max: z.number().int() })
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
  research_questions: z.array(z.object({ id: z.string().regex(/^RQ[1-9][0-9]*$/), text: z.string().min(1) })).default([])
})
export type ThesisContext = z.infer<typeof ThesisContextSchema>

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

export const DEFAULT_LLM_CONFIG = {
  model: 'sonnet' as const,
  auto_summarize: false,
  max_input_chars: 400000,
  budget: { per_operation_usd: 0.5, per_batch_usd: 10, per_month_usd: null as number | null }
}

/** Strict version (no fallback), used to validate edits from the UI. */
export const LlmConfigShape = z.object({
  model: z.enum(LLM_MODELS).default('sonnet'),
  auto_summarize: z.boolean().default(false),
  max_input_chars: z.number().int().positive().default(400000),
  budget: z
    .object({
      per_operation_usd: z.number().positive().default(0.5),
      per_batch_usd: z.number().positive().default(10),
      per_month_usd: z.number().positive().nullable().default(null)
    })
    .prefault({})
})

/** An invalid `llm` block falls back to defaults instead of making project.yaml unreadable. */
export const LlmConfigSchema = LlmConfigShape.catch(() => structuredClone(DEFAULT_LLM_CONFIG))
export type LlmConfig = z.infer<typeof LlmConfigShape>

export const SUMMARY_STATUSES = ['none', 'generated', 'reviewed', 'stale', 'too_long', 'failed'] as const
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number]

/** One line of costs/<device-id>.jsonl. */
export interface CostEntry {
  at: string
  paper_id: string
  batch_id: string | null
  model: string
  cost_usd: number
  operation: 'summarize'
}

/** The `thesis` section has a single key, `relation`. */
export type Section = 'fields' | 'facets' | 'thesis'

/** One field, facet or thesis relation still waiting for the user's review. */
export interface ReviewItem {
  paperId: string
  title: string
  section: Section
  key: string
}

export interface SummaryPlan {
  count: number
  estimateUsd: number
  batchLimitUsd: number
}

export type FormInfo = { status: 'missing' } | { status: 'ok'; form: ExtractionForm } | { status: 'invalid'; errors: string[] }
