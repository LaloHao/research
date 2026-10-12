import { describe, expect, it } from 'vitest'
import type { FacetOverview } from '../../../src/main/facets/facetOverview'
import { checkExamples, parseFacetOutput, toSuggestion, type FacetOutputContext } from '../../../src/main/facets/facetSuggestionOutput'
import { MAX_FACET_SUGGESTIONS } from '../../../src/main/facets/facetSuggestionPrompt'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import type { PageText } from '../../../src/main/summary/paperText'
import { FacetSuggestionSchema } from '../../../src/shared/facetSuggestions'
import { facetAgentAnswer } from '../../helpers/facets'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES } from '../../helpers/pair'

const overview: FacetOverview = {
  papers: 2,
  facets: [{ key: 'sanitization_technique', type: 'multi', description: 'd', allowed: [], filled: 2, values: [], proposed: [{ value: 'regex_rules', papers: [LOGHUB_ID] }, { value: 'regexes', papers: [DRAIN_ID] }] }]
}
const ctx = (over: Partial<FacetOutputContext> = {}): FacetOutputContext => ({
  form: { ...DEFAULT_EXTRACTION_FORM, value_aliases: { data_type: { log_lines: 'logs' } } },
  overview,
  rejected: new Set(),
  papers: new Set([DRAIN_ID, LOGHUB_ID]),
  ...over
})
const newFacet = (over: object) => ({ key: 'data_source', type: 'multi', description: 'd', values: ['a_b'], min: null, max: null, rationale: 'r', examples: [], ...over })
const newValue = (over: object) => ({ facet: 'data_type', value: 'metrics', rationale: 'r', examples: [], ...over })
const alias = (over: object) => ({ facet: 'sanitization_technique', from: ['regex_rules'], to: 'rules_regex', rationale: 'r', examples: [], ...over })

describe('parseFacetOutput', () => {
  it('keeps one valid suggestion of each kind, with examples only from library papers', () => {
    const answer = facetAgentAnswer()
    ;(answer.new_facets[0] as { examples: unknown[] }).examples.push({ paper: 'other2020x', value: 'x', quote: 'q', page: 1 })
    const out = parseFacetOutput(answer, ctx())
    expect(out).toMatchObject({ ok: true, dropped: [] })
    if (!out.ok) return
    expect(out.suggestions.map((s) => s.id)).toEqual(['new_facet__data_source', 'new_value__data_type__metrics', 'alias__sanitization_technique__rules_regex'])
    expect(out.suggestions[0]).toMatchObject({ kind: 'new_facet', facet: { key: 'data_source', type: 'multi', values: ['production_logs', 'public_dataset'] }, examples: [{ paper: LOGHUB_ID }] })
    expect(out.suggestions[0].examples).toHaveLength(1)
  })

  it('drops invalid, existing, rejected, duplicated and unknown items, each with its reason', () => {
    const out = parseFacetOutput(
      {
        new_facets: [
          newFacet({ key: 'Data Source' }),
          newFacet({ key: 'data__source' }),
          newFacet({ key: 'rigor' }),
          newFacet({ key: 'quality', type: 'scale', values: [] }),
          newFacet({ key: 'notes_kind', values: ['Bad Value'] }),
          newFacet({}),
          newFacet({})
        ],
        new_values: [newValue({ facet: 'traceability' }), newValue({ facet: 'nope' }), newValue({ value: 'logs' }), newValue({ value: 'log_lines' }), newValue({ value: 'metrics' })],
        aliases: [alias({ from: ['never_proposed'] }), alias({ to: 'Bad' })]
      },
      ctx({ rejected: new Set(['new_value__data_type__metrics']) })
    )
    expect(out).toMatchObject({ ok: true })
    if (!out.ok) return
    expect(out.suggestions.map((s) => s.id)).toEqual(['new_facet__data_source'])
    expect(out.dropped).toEqual(['invalid', 'invalid', 'exists', 'invalid', 'invalid', 'duplicate', 'unknown_facet', 'unknown_facet', 'exists', 'exists', 'rejected', 'unknown_source', 'invalid'])
  })

  it('builds valid text and scale facets, and joins aliases with the same target', () => {
    const out = parseFacetOutput(
      {
        new_facets: [newFacet({ key: 'threat_model', type: 'text', values: ['ignored'] }), newFacet({ key: 'maturity', type: 'scale', values: [], min: 1, max: 3 })],
        new_values: [],
        aliases: [alias({}), alias({ from: ['regexes', 'rules_regex'] })]
      },
      ctx()
    )
    if (!out.ok) throw new Error('expected ok')
    expect(out.suggestions).toMatchObject([
      { kind: 'new_facet', facet: { key: 'threat_model', type: 'text', description: 'd' } },
      { kind: 'new_facet', facet: { key: 'maturity', type: 'scale', min: 1, max: 3 } },
      { kind: 'alias', from: ['regex_rules', 'regexes'], to: 'rules_regex' }
    ])
    const text = out.suggestions[0]
    expect(text.kind === 'new_facet' && 'values' in text.facet).toBe(false)
  })

  it(`keeps at most ${MAX_FACET_SUGGESTIONS} suggestions and refuses an answer without the three lists`, () => {
    const many = Array.from({ length: MAX_FACET_SUGGESTIONS + 2 }, (_, i) => newFacet({ key: `facet_${String.fromCharCode(97 + i)}` }))
    const out = parseFacetOutput({ new_facets: many, new_values: [], aliases: [] }, ctx())
    if (!out.ok) throw new Error('expected ok')
    expect(out.suggestions).toHaveLength(MAX_FACET_SUGGESTIONS)
    expect(out.dropped).toEqual(['too_many', 'too_many'])
    expect(parseFacetOutput({ new_facets: [] }, ctx())).toEqual({ ok: false })
    expect(parseFacetOutput('nope', ctx())).toEqual({ ok: false })
  })
})

describe('parseFacetOutput edge cases', () => {
  const withProposed = (proposed: string[]): FacetOverview => ({
    papers: 2,
    facets: [{ key: 'sanitization_technique', type: 'multi', description: 'd', allowed: [], filled: 2, values: [], proposed: proposed.map((value) => ({ value, papers: [LOGHUB_ID] })) }]
  })

  it('aliases proposed values that are not snake_case into an entry the file accepts, but not over-long ones', () => {
    const long = 'x'.repeat(201)
    const out = parseFacetOutput(
      { new_facets: [], new_values: [], aliases: [alias({ from: ['3gpp_rules', 'Regex Rules', long] }), alias({ to: 'masking', from: [long] })] },
      ctx({ overview: withProposed(['3gpp_rules', 'Regex Rules', long]) })
    )
    if (!out.ok) throw new Error('expected ok')
    expect(out.suggestions).toMatchObject([{ kind: 'alias', from: ['3gpp_rules', 'Regex Rules'], to: 'rules_regex' }])
    expect(out.dropped).toEqual(['unknown_source'])
    const origin = { model: 'm', at: '2026-10-11T12:00:00.000Z', prompt_version: 1 }
    expect(FacetSuggestionSchema.safeParse(toSuggestion(out.suggestions[0], [], origin, origin.at)).success).toBe(true)
  })

  it('drops a target the form already aliases away, an inherited-key lookalike only when it exists, and `__` names', () => {
    const form = { ...DEFAULT_EXTRACTION_FORM, value_aliases: { sanitization_technique: { masked: 'rules_regex' }, data_type: { log_lines: 'logs' } } }
    const out = parseFacetOutput(
      {
        new_facets: [],
        new_values: [newValue({ value: 'constructor' }), newValue({ value: 'met__rics' })],
        aliases: [alias({ to: 'masked' }), alias({ to: 'rules__regex' })]
      },
      ctx({ form })
    )
    if (!out.ok) throw new Error('expected ok')
    expect(out.suggestions.map((s) => s.id)).toEqual(['new_value__data_type__constructor'])
    expect(out.dropped).toEqual(['invalid', 'exists', 'invalid'])
  })

  it('drops rejected aliases and facets, and garbage items, as such', () => {
    const out = parseFacetOutput(
      { new_facets: [newFacet({}), null, 3], new_values: [{ facet: 'data_type' }], aliases: [alias({}), 'x'] },
      ctx({ rejected: new Set(['new_facet__data_source', 'alias__sanitization_technique__rules_regex']) })
    )
    expect(out).toEqual({ ok: true, suggestions: [], dropped: ['rejected', 'invalid', 'invalid', 'invalid', 'rejected', 'invalid'] })
  })
})

describe('checkExamples and toSuggestion', () => {
  it('marks quotes it cannot find, corrects their page, and builds an entry the file accepts', () => {
    const pages: Record<string, PageText[]> = { [LOGHUB_ID]: LOGHUB_PAGES.map((text, i) => ({ page: i + 1, text })), [DRAIN_ID]: DRAIN_PAGES.map((text, i) => ({ page: i + 1, text })) }
    const examples = checkExamples(
      [
        { paper: LOGHUB_ID, value: 'public_dataset', quote: LOGHUB_PAGES[1], page: 1 },
        { paper: DRAIN_ID, value: null, quote: 'an invented sentence', page: 2 }
      ],
      (id) => pages[id] ?? []
    )
    expect(examples).toEqual([
      { paper: LOGHUB_ID, value: 'public_dataset', quote: LOGHUB_PAGES[1], page: 2, found: true },
      { paper: DRAIN_ID, value: null, quote: 'an invented sentence', page: 2, found: false }
    ])
    const out = parseFacetOutput(facetAgentAnswer(), ctx())
    if (!out.ok) throw new Error('expected ok')
    const origin = { model: 'claude-sonnet-5', at: '2026-10-11T12:00:00.000Z', prompt_version: 1 }
    for (const p of out.suggestions) {
      const s = toSuggestion(p, examples, origin, origin.at)
      expect(FacetSuggestionSchema.parse(s)).toMatchObject({ id: p.id, status: 'suggested', updated_at: origin.at, origin })
    }
  })
})
