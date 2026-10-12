import { z } from 'zod'
import { isAliasSource, isSuggestionName, suggestionId, type FacetSuggestion, type SuggestionExample } from '../../shared/facetSuggestions'
import { FACET_TYPES, FacetDefSchema, type ExtractionForm, type FacetDef, type Provenance } from '../../shared/summary'
import { locateQuote } from '../summary/evidence'
import type { PageText } from '../summary/paperText'
import type { FacetOverview } from './facetOverview'
import { MAX_EXAMPLES, MAX_FACET_SUGGESTIONS } from './facetSuggestionPrompt'

/** A stray non-positive page (the model miscounts, or means "no page") becomes null rather than dropping the example. */
const PageSchema = z
  .number()
  .int()
  .nullable()
  .transform((v) => (v !== null && v <= 0 ? null : v))
const ExampleSchema = z.object({ paper: z.string(), value: z.string().nullable(), quote: z.string().trim().min(1), page: PageSchema })
const prose = z.string().trim().min(1)
const NewFacetItem = z.object({
  key: z.string(),
  type: z.enum(FACET_TYPES),
  description: prose,
  values: z.array(z.string()),
  min: z.number().int().nullable(),
  max: z.number().int().nullable(),
  rationale: prose,
  examples: z.array(z.unknown())
})
const NewValueItem = z.object({ facet: z.string(), value: z.string(), rationale: prose, examples: z.array(z.unknown()) })
const AliasItem = z.object({ facet: z.string(), from: z.array(z.string()), to: z.string(), rationale: prose, examples: z.array(z.unknown()) })
const OutputSchema = z.object({ new_facets: z.array(z.unknown()), new_values: z.array(z.unknown()), aliases: z.array(z.unknown()) })

export type FacetDropReason = 'invalid' | 'exists' | 'rejected' | 'duplicate' | 'unknown_facet' | 'unknown_source' | 'too_many'

export interface ParsedExample {
  paper: string
  value: string | null
  quote: string
  page: number | null
}

interface ParsedCommon {
  id: string
  rationale: string
  examples: ParsedExample[]
}

export type ParsedFacetSuggestion =
  | (ParsedCommon & { kind: 'new_facet'; facet: FacetDef })
  | (ParsedCommon & { kind: 'new_value'; facet: string; value: string })
  | (ParsedCommon & { kind: 'alias'; facet: string; from: string[]; to: string })

export interface FacetOutputContext {
  form: ExtractionForm
  overview: FacetOverview
  /** Ids of suggestions the user rejected. */
  rejected: ReadonlySet<string>
  /** Readable library papers: examples from anything else are dropped. */
  papers: ReadonlySet<string>
}

export type ParsedFacetOutput = { ok: true; suggestions: ParsedFacetSuggestion[]; dropped: FacetDropReason[] } | { ok: false }

function examplesOf(raw: unknown[], papers: ReadonlySet<string>): ParsedExample[] {
  const out: ParsedExample[] = []
  for (const e of raw) {
    const parsed = ExampleSchema.safeParse(e)
    if (parsed.success && papers.has(parsed.data.paper)) out.push(parsed.data)
    if (out.length >= MAX_EXAMPLES) break
  }
  return out
}

/** The facet a new-facet item describes, or null when it is not a valid one (a scale without its range, a bad value…). */
function facetOf(item: z.infer<typeof NewFacetItem>): FacetDef | null {
  const base = { key: item.key, description: item.description }
  const values = [...new Set(item.values)]
  const candidate =
    item.type === 'text'
      ? { ...base, type: 'text' as const }
      : item.type === 'scale'
        ? { ...base, type: 'scale' as const, min: item.min, max: item.max }
        : { ...base, type: item.type, values }
  if ('values' in candidate && candidate.values.some((v) => !isSuggestionName(v))) return null
  const parsed = FacetDefSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function choiceFacet(form: ExtractionForm, key: string): (FacetDef & { values: string[] }) | null {
  const def = form.facets.find((f) => f.key === key)
  return def && 'values' in def ? def : null
}

/** Item by item: a bad item is dropped with its reason; only a missing list makes the whole answer invalid. */
export function parseFacetOutput(value: unknown, ctx: FacetOutputContext): ParsedFacetOutput {
  const top = OutputSchema.safeParse(value)
  if (!top.success) return { ok: false }
  const dropped: FacetDropReason[] = []
  const kept = new Map<string, ParsedFacetSuggestion>()
  const keep = (s: ParsedFacetSuggestion): void => {
    if (ctx.rejected.has(s.id)) return void dropped.push('rejected')
    const same = kept.get(s.id)
    if (same) {
      // Two aliases with the same target are one suggestion with both sources.
      if (same.kind === 'alias' && s.kind === 'alias') {
        kept.set(s.id, { ...same, from: [...new Set([...same.from, ...s.from])], examples: [...same.examples, ...s.examples].slice(0, MAX_EXAMPLES) })
      } else {
        dropped.push('duplicate')
      }
      return
    }
    if (kept.size >= MAX_FACET_SUGGESTIONS) return void dropped.push('too_many')
    kept.set(s.id, s)
  }
  const keys = new Set(ctx.form.facets.map((f) => f.key))

  for (const raw of top.data.new_facets) {
    const item = NewFacetItem.safeParse(raw)
    if (!item.success || !isSuggestionName(item.data.key)) {
      dropped.push('invalid')
      continue
    }
    if (keys.has(item.data.key)) {
      dropped.push('exists')
      continue
    }
    const facet = facetOf(item.data)
    if (!facet) {
      dropped.push('invalid')
      continue
    }
    keep({ kind: 'new_facet', id: suggestionId({ kind: 'new_facet', facet }), facet, rationale: item.data.rationale, examples: examplesOf(item.data.examples, ctx.papers) })
  }

  for (const raw of top.data.new_values) {
    const item = NewValueItem.safeParse(raw)
    if (!item.success) {
      dropped.push('invalid')
      continue
    }
    const { facet, value } = item.data
    const def = choiceFacet(ctx.form, facet)
    if (!def) {
      dropped.push('unknown_facet')
      continue
    }
    if (!isSuggestionName(value)) {
      dropped.push('invalid')
      continue
    }
    if (def.values.includes(value) || Object.hasOwn(ctx.form.value_aliases[facet] ?? {}, value)) {
      dropped.push('exists')
      continue
    }
    keep({ kind: 'new_value', id: suggestionId({ kind: 'new_value', facet, value }), facet, value, rationale: item.data.rationale, examples: examplesOf(item.data.examples, ctx.papers) })
  }

  for (const raw of top.data.aliases) {
    const item = AliasItem.safeParse(raw)
    if (!item.success) {
      dropped.push('invalid')
      continue
    }
    const { facet, to } = item.data
    if (!choiceFacet(ctx.form, facet)) {
      dropped.push('unknown_facet')
      continue
    }
    if (!isSuggestionName(to)) {
      dropped.push('invalid')
      continue
    }
    // A target the form already maps away would come back as an allowed value while still aliased.
    if (Object.hasOwn(ctx.form.value_aliases[facet] ?? {}, to)) {
      dropped.push('exists')
      continue
    }
    const proposed = new Set(ctx.overview.facets.find((u) => u.key === facet)?.proposed.map((p) => p.value) ?? [])
    // A source is any proposed value (free text, like value_aliases' keys), not necessarily snake_case.
    const from = [...new Set(item.data.from)].filter((v) => v !== to && proposed.has(v) && isAliasSource(v))
    if (from.length === 0) {
      dropped.push('unknown_source')
      continue
    }
    keep({ kind: 'alias', id: suggestionId({ kind: 'alias', facet, to }), facet, from, to, rationale: item.data.rationale, examples: examplesOf(item.data.examples, ctx.papers) })
  }

  return { ok: true, suggestions: [...kept.values()], dropped }
}

/** Like the summaries: each quote is looked up in its own paper's indexed text; `found` false when it is not there. */
export function checkExamples(examples: ParsedExample[], pagesOf: (paperId: string) => PageText[]): SuggestionExample[] {
  return examples.map((e) => {
    const r = locateQuote(e.quote, pagesOf(e.paper), e.page)
    return { paper: e.paper, value: e.value, quote: e.quote, page: r.page, found: r.found }
  })
}

/** The entry facet-suggestions.yaml keeps for a checked suggestion. */
export function toSuggestion(p: ParsedFacetSuggestion, examples: SuggestionExample[], origin: Provenance, at: string): FacetSuggestion {
  const common = { id: p.id, status: 'suggested' as const, rationale: p.rationale, examples, origin, updated_at: at }
  switch (p.kind) {
    case 'new_facet':
      return { ...common, kind: 'new_facet', facet: p.facet }
    case 'new_value':
      return { ...common, kind: 'new_value', facet: p.facet, value: p.value }
    case 'alias':
      return { ...common, kind: 'alias', facet: p.facet, from: p.from, to: p.to }
  }
}
