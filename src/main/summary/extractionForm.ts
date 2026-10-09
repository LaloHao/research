import { z } from 'zod'
import { ExtractionFormSchema, type ExtractionForm } from '../../shared/summary'
import { sha256 } from '../project/atomicWrite'

/** The draft offered when a project has no form yet (from the thesis design). */
export const DEFAULT_EXTRACTION_FORM: ExtractionForm = {
  facets: [
    {
      key: 'sanitization_technique',
      type: 'multi',
      description: 'How sensitive data in logs is removed or transformed',
      values: ['rules_regex', 'ner', 'pseudonymization', 'differential_privacy', 'llm_based', 'none']
    },
    { key: 'data_type', type: 'multi', description: 'Kind of operational data the work processes', values: ['logs', 'traces', 'tickets', 'postmortems', 'code', 'chat'] },
    { key: 'llm_usage', type: 'single', description: 'How language models are used, if at all', values: ['none', 'cloud_api', 'local', 'fine_tuned'] },
    {
      key: 'task',
      type: 'multi',
      description: 'Main task the work addresses',
      values: ['anonymization', 'log_parsing', 'root_cause_analysis', 'postmortem_generation', 'summarization']
    },
    { key: 'traceability', type: 'text', description: 'Whether and how outputs are linked back to their source evidence' },
    { key: 'privacy_evaluation', type: 'text', description: 'How privacy or leakage is evaluated (metrics, datasets)' },
    { key: 'relevance', type: 'scale', min: 1, max: 5, description: 'Relevance to the thesis research questions, with justification' }
  ],
  value_aliases: {}
}

export type FormLoad = { status: 'missing' } | { status: 'ok'; form: ExtractionForm; hash: string } | { status: 'invalid'; errors: string[] }

export function loadForm(raw: unknown): FormLoad {
  if (raw === undefined || raw === null) return { status: 'missing' }
  const result = ExtractionFormSchema.safeParse(raw)
  if (!result.success) return { status: 'invalid', errors: z.prettifyError(result.error).split('\n').filter(Boolean) }
  const keys = result.data.facets.map((f) => f.key)
  const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i)
  if (duplicated.length) return { status: 'invalid', errors: [`Duplicated facet keys: ${[...new Set(duplicated)].join(', ')}`] }
  return { status: 'ok', form: result.data, hash: formHash(result.data) }
}

/** Hash of the facet definitions only: editing value_aliases, or adding/removing allowed `values`, does not make summaries stale. */
export function formHash(form: ExtractionForm): string {
  const facets = form.facets.map((f) => {
    if (!('values' in f)) return f
    const { values: _values, ...rest } = f
    return rest
  })
  return sha256(JSON.stringify(sortKeys(facets)))
}

const toSnake = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** Splits LLM-returned values into allowed ones (after aliases) and genuine new proposals. */
export function applyAliases(form: ExtractionForm, facetKey: string, values: string[]): { known: string[]; proposed: string[] } {
  const facet = form.facets.find((f) => f.key === facetKey)
  const allowed = new Set(facet && 'values' in facet ? facet.values : [])
  const aliases = form.value_aliases[facetKey] ?? {}
  const known: string[] = []
  const proposed: string[] = []
  for (const raw of values) {
    const v = toSnake(raw)
    if (!v) continue
    const mapped = aliases[v] ?? v
    if (allowed.has(mapped)) {
      if (!known.includes(mapped)) known.push(mapped)
    } else if (!proposed.includes(mapped)) {
      proposed.push(mapped)
    }
  }
  return { known, proposed }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    )
  }
  return value
}
