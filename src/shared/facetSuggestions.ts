import { z } from 'zod'
import { FACET_KEY_PATTERN, FacetDefSchema, ProvenanceSchema, type FacetDef } from './summary'

/** What Claude can suggest for the extraction form. */
export const FACET_SUGGESTION_KINDS = ['new_facet', 'new_value', 'alias'] as const
export type FacetSuggestionKind = (typeof FACET_SUGGESTION_KINDS)[number]

export const FACET_SUGGESTION_STATUSES = ['suggested', 'accepted', 'rejected'] as const
export type FacetSuggestionStatus = (typeof FACET_SUGGESTION_STATUSES)[number]

const key = z.string().regex(FACET_KEY_PATTERN)
const paperKey = z.string().regex(/^[a-z][a-z0-9]*$/)

/** Longest alias source kept: a proposed value is free text (`3gpp_rules`, a hand-edited entry), like `value_aliases`' keys. */
export const ALIAS_SOURCE_MAX_CHARS = 200
/** Any non-empty proposed value may be aliased away, as `value_aliases` accepts; only the target must be a facet value. */
export function isAliasSource(v: string): boolean {
  return v.length > 0 && v.length <= ALIAS_SOURCE_MAX_CHARS
}
const aliasSource = z.string().refine(isAliasSource, { message: `must be 1–${ALIAS_SOURCE_MAX_CHARS} characters` })

/** `<kind>__<target>`: the kind plus what it changes, so a suggestion keeps its id across runs and machines. */
export const SUGGESTION_ID = /^(?:new_facet__[a-z][a-z0-9_]*|(?:new_value|alias)__[a-z][a-z0-9_]*__[a-z][a-z0-9_]*)$/

/** A key or value Claude (or the user, editing a suggestion) may propose: snake_case, never with `__`, the id separator. */
export function isSuggestionName(v: string): boolean {
  return FACET_KEY_PATTERN.test(v) && !v.includes('__')
}

type IdParts = { kind: 'new_facet'; facet: { key: string } } | { kind: 'new_value'; facet: string; value: string } | { kind: 'alias'; facet: string; to: string }

export function suggestionId(s: IdParts): string {
  switch (s.kind) {
    case 'new_facet':
      return `new_facet__${s.facet.key}`
    case 'new_value':
      return `new_value__${s.facet}__${s.value}`
    case 'alias':
      return `alias__${s.facet}__${s.to}`
  }
}

/**
 * The part of the id an edit cannot change: the kind, plus the facet for a value or an alias. «Editar y aceptar» keeps
 * the id while changing the key, value or target it was built from, so a decided suggestion only has to keep this prefix;
 * a suggestion still waiting for review must match its id exactly.
 */
function idPrefix(s: { kind: FacetSuggestionKind; facet: unknown }): string {
  return s.kind === 'new_facet' ? 'new_facet__' : `${s.kind}__${String(s.facet)}__`
}

export const SuggestionExampleSchema = z.object({
  paper: paperKey,
  /** The value this paper would get; null for an alias. */
  value: z.string().nullable(),
  quote: z.string().min(1),
  /** 1-based page; null for page-less text (web pages). */
  page: z.number().int().positive().nullable(),
  /** Whether the quote was found in that paper's extracted text. */
  found: z.boolean()
})
export type SuggestionExample = z.infer<typeof SuggestionExampleSchema>

const common = {
  id: z.string().regex(SUGGESTION_ID),
  status: z.enum(FACET_SUGGESTION_STATUSES),
  /** How the suggestion serves the research questions (for an alias: why the values are synonyms). */
  rationale: z.string().min(1),
  examples: z.array(SuggestionExampleSchema).default([]),
  origin: ProvenanceSchema,
  updated_at: z.string()
}

/** Loose: keys added by a later version survive a round trip (and the sync's merge). */
export const FacetSuggestionSchema = z
  .discriminatedUnion('kind', [
    z.looseObject({ ...common, kind: z.literal('new_facet'), facet: FacetDefSchema }),
    z.looseObject({ ...common, kind: z.literal('new_value'), facet: key, value: key }),
    z.looseObject({ ...common, kind: z.literal('alias'), facet: key, from: z.array(aliasSource).min(1), to: key })
  ])
  .refine((s) => (s.status === 'suggested' ? s.id === suggestionId(s) : s.id.startsWith(idPrefix(s))), { message: 'id does not match the suggestion', path: ['id'] })
export type FacetSuggestion = z.infer<typeof FacetSuggestionSchema>

export const LastRunSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  /** Papers with an up-to-date summary at the last successful run: the automatic trigger counts new ones from here. */
  summarized: z.number().int().min(0),
  model: z.string().optional()
})
export type LastRun = z.infer<typeof LastRunSchema>

/** facet-suggestions.yaml at the project root. */
export const FacetSuggestionsFileSchema = z.looseObject({
  schema_version: z.literal(1),
  suggestions: z.array(FacetSuggestionSchema).default([]),
  last_run: LastRunSchema.optional()
})
export type FacetSuggestionsFile = z.infer<typeof FacetSuggestionsFileSchema>

/** Whether a suggestion still applies to the current form; each reason has a text under `facets.invalid.<reason>`. */
export const SUGGESTION_VALIDITIES = ['ok', 'facet_exists', 'facet_missing', 'not_a_choice', 'value_exists', 'source_gone'] as const
export type SuggestionValidity = (typeof SUGGESTION_VALIDITIES)[number]

export interface FacetSuggestionView {
  suggestion: FacetSuggestion
  validity: SuggestionValidity
}

export type FacetSuggestionsFileState = { status: 'missing' } | { status: 'ok' } | { status: 'conflict' } | { status: 'invalid'; message: string }

export interface FacetSuggestionList {
  file: FacetSuggestionsFileState
  suggestions: FacetSuggestionView[]
  /** Suggestions waiting for a decision («N sugerencias por revisar»). */
  pending: number
  /** A suggestion run is queued or running. */
  running: boolean
  lastRun: LastRun | null
}

/** What «Sugerir facetas» would cost: the learned estimate, the run's own cap, and the papers it would look at. */
export interface FacetSuggestPlan {
  estimateUsd: number
  capUsd: number
  papers: number
}

/** «Editar y aceptar»: the user's version of the proposal, of the suggestion's own kind. */
export type SuggestionEdit = { kind: 'new_facet'; facet: FacetDef } | { kind: 'new_value'; value: string } | { kind: 'alias'; to: string }
