import type { CompleteResult } from '../../src/main/llm/LlmProvider'
import type { FacetSuggestion } from '../../src/shared/facetSuggestions'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES } from './pair'

export type NewFacetSuggestion = Extract<FacetSuggestion, { kind: 'new_facet' }>
export type NewValueSuggestion = Extract<FacetSuggestion, { kind: 'new_value' }>
export type AliasSuggestion = Extract<FacetSuggestion, { kind: 'alias' }>

const AT = '2026-10-11T00:00:00.000Z'
const ORIGIN = { model: 'claude-sonnet-5', at: AT, prompt_version: 1 }

/** A new multi facet `data_source`; the id follows the facet's key unless given. */
export function newFacetSuggestion(over: Partial<NewFacetSuggestion> = {}): NewFacetSuggestion {
  const facet = over.facet ?? { key: 'data_source', type: 'multi' as const, description: 'Where the analyzed log data comes from', values: ['production_logs', 'public_dataset'] }
  return {
    kind: 'new_facet',
    status: 'suggested',
    rationale: 'RQ1 asks whether techniques hold on production logs, not only on public benchmarks.',
    examples: [{ paper: 'zhu2020loghub', value: 'public_dataset', quote: 'Loghub is a large collection of system log datasets.', page: 1, found: true }],
    origin: ORIGIN,
    updated_at: AT,
    ...over,
    facet,
    id: over.id ?? `new_facet__${facet.key}`
  }
}

/** `metrics` for the default form's `data_type`. */
export function newValueSuggestion(over: Partial<NewValueSuggestion> = {}): NewValueSuggestion {
  const facet = over.facet ?? 'data_type'
  const value = over.value ?? 'metrics'
  return {
    kind: 'new_value',
    status: 'suggested',
    rationale: 'Several papers analyze metrics next to logs.',
    examples: [],
    origin: ORIGIN,
    updated_at: AT,
    ...over,
    facet,
    value,
    id: over.id ?? `new_value__${facet}__${value}`
  }
}

/** The proposal `regex_rules` merged into the default form's `rules_regex`. */
export function aliasSuggestion(over: Partial<AliasSuggestion> = {}): AliasSuggestion {
  const facet = over.facet ?? 'sanitization_technique'
  const to = over.to ?? 'rules_regex'
  return {
    kind: 'alias',
    status: 'suggested',
    from: ['regex_rules'],
    rationale: 'Both name rule-based masking with regular expressions.',
    examples: [],
    origin: ORIGIN,
    updated_at: AT,
    ...over,
    facet,
    to,
    id: over.id ?? `alias__${facet}__${to}`
  }
}

/** The agent's structured answer: one suggestion of each kind for the default form, quoting pair.ts verbatim. */
export function facetAgentAnswer(over: Partial<{ new_facets: unknown[]; new_values: unknown[]; aliases: unknown[] }> = {}) {
  return {
    new_facets: [
      {
        key: 'data_source',
        type: 'multi',
        description: 'Where the analyzed log data comes from',
        values: ['production_logs', 'public_dataset'],
        min: null,
        max: null,
        rationale: 'Separates studies on public benchmarks from those on production logs (RQ1).',
        examples: [{ paper: LOGHUB_ID, value: 'public_dataset', quote: LOGHUB_PAGES[0], page: 1 }]
      }
    ] as unknown[],
    new_values: [{ facet: 'data_type', value: 'metrics', rationale: 'Several papers analyze metrics next to logs.', examples: [] }] as unknown[],
    aliases: [
      {
        facet: 'sanitization_technique',
        from: ['regex_rules'],
        to: 'rules_regex',
        rationale: 'Both name rule-based masking.',
        examples: [{ paper: DRAIN_ID, value: null, quote: DRAIN_PAGES[0], page: 1 }]
      }
    ] as unknown[],
    ...over
  }
}

export function facetAgentResult(answer: object = facetAgentAnswer(), costUsd = 0.4): CompleteResult {
  return { value: answer, costUsd, model: 'claude-sonnet-5' }
}
