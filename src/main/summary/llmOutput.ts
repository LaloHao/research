import { z } from 'zod'
import {
  LimitationsSchema,
  RESEARCH_TYPES,
  SUMMARY_TEXT_FIELDS,
  type Evidence,
  type ExtractionFile,
  type ExtractionForm,
  type FacetDef,
  type FacetEntry,
  type Provenance,
  type SummaryFieldKey,
  type SummaryFile,
  type ThesisContext,
  type ThesisRelation
} from '../../shared/summary'
import { applyAliases } from './extractionForm'
import { hasThesisContext, thesisHash } from './thesis'

export interface LlmEvidence {
  quote: string
  page: number | null
}

export interface LlmFacet {
  value?: string | null
  values?: string[]
  text?: string
  score?: number
  justification?: string
  proposed?: string[]
  evidence: LlmEvidence[]
}

export interface LlmThesisRelation {
  text: string
  research_questions: string[]
  score: number
  justification: string
  evidence: LlmEvidence[]
}

export interface LlmOutput {
  fields: Record<SummaryFieldKey, { value: unknown; evidence: LlmEvidence[] }>
  facets: Record<string, LlmFacet>
  /** Only asked for when the project has a thesis context. */
  thesis_relation?: LlmThesisRelation
}

/** The thesis context, or null when there is none worth asking about. */
const activeThesis = (thesis: ThesisContext | null | undefined): ThesisContext | null => (thesis && hasThesisContext(thesis) ? thesis : null)

function obj(properties: Record<string, object>): object {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
}

const str = { type: 'string' }
const strArr = { type: 'array', items: str }
const evidenceJson = {
  type: 'array',
  items: obj({ quote: str, page: { anyOf: [{ type: 'integer' }, { type: 'null' }] } })
}

const range = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i)

function facetJson(f: FacetDef): object {
  switch (f.type) {
    case 'single':
      return obj({ value: { anyOf: [{ type: 'string', enum: f.values }, { type: 'null' }] }, proposed: strArr, evidence: evidenceJson })
    case 'multi':
      return obj({ values: { type: 'array', items: { type: 'string', enum: f.values } }, proposed: strArr, evidence: evidenceJson })
    case 'text':
      return obj({ text: str, evidence: evidenceJson })
    case 'scale':
      return obj({ score: { type: 'integer', enum: range(f.min, f.max) }, justification: str, evidence: evidenceJson })
  }
}

function thesisJson(t: ThesisContext): object {
  const ids = t.research_questions.map((q) => q.id)
  return obj({
    text: str,
    research_questions: ids.length ? { type: 'array', items: { type: 'string', enum: ids } } : strArr,
    score: { type: 'integer', enum: range(1, 5) },
    justification: str,
    evidence: evidenceJson
  })
}

export function outputJsonSchema(form: ExtractionForm, thesis?: ThesisContext | null): object {
  const fields: Record<string, object> = Object.fromEntries(SUMMARY_TEXT_FIELDS.map((k) => [k, obj({ value: str, evidence: evidenceJson })]))
  fields.limitations = obj({ value: obj({ stated: strArr, inferred: strArr }), evidence: evidenceJson })
  fields.research_type = obj({ value: { type: 'string', enum: [...RESEARCH_TYPES] }, evidence: evidenceJson })
  const t = activeThesis(thesis)
  return obj({
    fields: obj(fields),
    facets: obj(Object.fromEntries(form.facets.map((f) => [f.key, facetJson(f)]))),
    ...(t ? { thesis_relation: thesisJson(t) } : {})
  })
}

const evidenceZod = z.array(z.object({ quote: z.string(), page: z.number().int().nullable() }))

function facetZod(f: FacetDef): z.ZodType {
  switch (f.type) {
    case 'single':
      return z.object({ value: z.string().nullable(), proposed: z.array(z.string()), evidence: evidenceZod })
    case 'multi':
      return z.object({ values: z.array(z.string()), proposed: z.array(z.string()), evidence: evidenceZod })
    case 'text':
      return z.object({ text: z.string(), evidence: evidenceZod })
    case 'scale':
      return z.object({ score: z.number().int().min(f.min).max(f.max), justification: z.string(), evidence: evidenceZod })
  }
}

const thesisZod = z.object({
  text: z.string(),
  research_questions: z.array(z.string()),
  score: z.number().int().min(1).max(5),
  justification: z.string(),
  evidence: evidenceZod
})

function outputZod(form: ExtractionForm, thesis: ThesisContext | null): z.ZodType {
  const textField = z.object({ value: z.string(), evidence: evidenceZod })
  return z.object({
    ...(thesis ? { thesis_relation: thesisZod } : {}),
    fields: z.object({
      ...Object.fromEntries(SUMMARY_TEXT_FIELDS.map((k) => [k, textField])),
      limitations: z.object({ value: LimitationsSchema, evidence: evidenceZod }),
      research_type: z.object({ value: z.enum(RESEARCH_TYPES), evidence: evidenceZod })
    }),
    facets: z.object(Object.fromEntries(form.facets.map((f) => [f.key, facetZod(f)])))
  })
}

export function parseLlmOutput(
  raw: unknown,
  form: ExtractionForm,
  thesis?: ThesisContext | null
): { ok: true; value: LlmOutput } | { ok: false; error: string } {
  const result = outputZod(form, activeThesis(thesis)).safeParse(raw)
  return result.success ? { ok: true, value: result.data as LlmOutput } : { ok: false, error: z.prettifyError(result.error) }
}

function toEvidence(list: LlmEvidence[]): Evidence[] {
  return list
    .filter((e) => e.quote.trim())
    .map((e) => ({ quote: e.quote.trim(), page: e.page !== null && e.page > 0 ? e.page : null, found: false }))
}

function facetEntry(form: ExtractionForm, f: FacetDef, out: LlmFacet, origin: Provenance): FacetEntry {
  const evidence = toEvidence(out.evidence ?? [])
  switch (f.type) {
    case 'single': {
      const { known, proposed } = applyAliases(form, f.key, [out.value ?? '', ...(out.proposed ?? [])].filter(Boolean))
      return { value: known[0] ?? null, proposed, status: 'generated', evidence, origin }
    }
    case 'multi': {
      const { known, proposed } = applyAliases(form, f.key, [...(out.values ?? []), ...(out.proposed ?? [])])
      return { values: known, proposed, status: 'generated', evidence, origin }
    }
    case 'text':
      return { text: out.text ?? '', proposed: [], status: 'generated', evidence, origin }
    case 'scale':
      return { score: out.score, justification: out.justification ?? '', proposed: [], status: 'generated', evidence, origin }
  }
}

/** Keeps only questions that exist in the thesis, once each (none when the thesis has no questions). */
function thesisRelation(out: LlmThesisRelation, t: ThesisContext, origin: Provenance): ThesisRelation {
  const ids = new Set(t.research_questions.map((q) => q.id))
  return {
    text: out.text,
    research_questions: [...new Set(out.research_questions.filter((q) => ids.has(q)))],
    score: out.score,
    justification: out.justification,
    status: 'generated',
    evidence: toEvidence(out.evidence ?? []),
    origin
  }
}

export function toGeneratedFiles(
  out: LlmOutput,
  form: ExtractionForm,
  formHash: string,
  meta: SummaryFile['generated'],
  thesis?: ThesisContext | null
): { summary: SummaryFile; extraction: ExtractionFile } {
  const origin: Provenance = { model: meta.model, at: meta.at, prompt_version: meta.prompt_version }
  const fields = Object.fromEntries(
    Object.entries(out.fields).map(([k, v]) => [k, { value: v.value, status: 'generated', evidence: toEvidence(v.evidence), origin }])
  )
  const facets = Object.fromEntries(form.facets.map((f) => [f.key, facetEntry(form, f, out.facets[f.key] ?? { evidence: [] }, origin)]))
  const extraction: ExtractionFile = { schema_version: 1, form_hash: formHash, facets }
  const t = activeThesis(thesis)
  if (t && out.thesis_relation) {
    extraction.thesis_relation = thesisRelation(out.thesis_relation, t, origin)
    extraction.thesis_hash = thesisHash(t)
  }
  return { summary: { schema_version: 1, generated: meta, fields } as SummaryFile, extraction }
}
