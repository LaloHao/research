import { z } from 'zod'
import {
  RESEARCH_TYPES,
  SUMMARY_TEXT_FIELDS,
  type Evidence,
  type ExtractionFile,
  type ExtractionForm,
  type FacetDef,
  type FacetEntry,
  type SummaryFieldKey,
  type SummaryFile
} from '../../shared/summary'
import { applyAliases } from './extractionForm'

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

export interface LlmOutput {
  fields: Record<SummaryFieldKey, { value: unknown; evidence: LlmEvidence[] }>
  facets: Record<string, LlmFacet>
}

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

export function outputJsonSchema(form: ExtractionForm): object {
  const fields: Record<string, object> = Object.fromEntries(SUMMARY_TEXT_FIELDS.map((k) => [k, obj({ value: str, evidence: evidenceJson })]))
  fields.limitations = obj({ value: obj({ stated: strArr, inferred: strArr }), evidence: evidenceJson })
  fields.research_type = obj({ value: { type: 'string', enum: [...RESEARCH_TYPES] }, evidence: evidenceJson })
  return obj({ fields: obj(fields), facets: obj(Object.fromEntries(form.facets.map((f) => [f.key, facetJson(f)]))) })
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

function outputZod(form: ExtractionForm): z.ZodType {
  const textField = z.object({ value: z.string(), evidence: evidenceZod })
  return z.object({
    fields: z.object({
      ...Object.fromEntries(SUMMARY_TEXT_FIELDS.map((k) => [k, textField])),
      limitations: z.object({ value: z.object({ stated: z.array(z.string()), inferred: z.array(z.string()) }), evidence: evidenceZod }),
      research_type: z.object({ value: z.enum(RESEARCH_TYPES), evidence: evidenceZod })
    }),
    facets: z.object(Object.fromEntries(form.facets.map((f) => [f.key, facetZod(f)])))
  })
}

export function parseLlmOutput(raw: unknown, form: ExtractionForm): { ok: true; value: LlmOutput } | { ok: false; error: string } {
  const result = outputZod(form).safeParse(raw)
  return result.success ? { ok: true, value: result.data as LlmOutput } : { ok: false, error: z.prettifyError(result.error) }
}

function toEvidence(list: LlmEvidence[]): Evidence[] {
  return list.filter((e) => e.quote.trim()).map((e) => ({ quote: e.quote.trim(), page: e.page, found: false }))
}

function facetEntry(form: ExtractionForm, f: FacetDef, out: LlmFacet): FacetEntry {
  const evidence = toEvidence(out.evidence ?? [])
  switch (f.type) {
    case 'single': {
      const { known, proposed } = applyAliases(form, f.key, [out.value ?? '', ...(out.proposed ?? [])].filter(Boolean))
      return { value: known[0] ?? null, proposed, status: 'generated', evidence }
    }
    case 'multi': {
      const { known, proposed } = applyAliases(form, f.key, [...(out.values ?? []), ...(out.proposed ?? [])])
      return { values: known, proposed, status: 'generated', evidence }
    }
    case 'text':
      return { text: out.text ?? '', proposed: [], status: 'generated', evidence }
    case 'scale':
      return { score: out.score, justification: out.justification ?? '', proposed: [], status: 'generated', evidence }
  }
}

export function toGeneratedFiles(
  out: LlmOutput,
  form: ExtractionForm,
  formHash: string,
  meta: SummaryFile['generated']
): { summary: SummaryFile; extraction: ExtractionFile } {
  const fields = Object.fromEntries(
    Object.entries(out.fields).map(([k, v]) => [k, { value: v.value, status: 'generated', evidence: toEvidence(v.evidence) }])
  )
  const facets = Object.fromEntries(form.facets.map((f) => [f.key, facetEntry(form, f, out.facets[f.key] ?? { evidence: [] })]))
  return {
    summary: { schema_version: 1, generated: meta, fields } as SummaryFile,
    extraction: { schema_version: 1, form_hash: formHash, facets }
  }
}
