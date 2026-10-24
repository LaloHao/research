import { describe, expect, it } from 'vitest'
import { ProjectConfigSchema } from '../../src/shared/schemas'
import { COST_OPERATIONS, ExtractionFileSchema, ExtractionFormSchema, LlmConfigSchema, SummaryFileSchema } from '../../src/shared/summary'

const field = (value: unknown) => ({ value, status: 'generated', evidence: [] })

const summary = {
  schema_version: 1,
  generated: { model: 'sonnet', at: '2026-10-08T00:00:00.000Z', cost_usd_est: 0.04, prompt_version: 1, language: 'en' },
  fields: {
    tldr: field('x'),
    problem: field('x'),
    contribution: field('x'),
    method: { value: 'BERT', status: 'verified', evidence: [{ quote: 'we fine-tune BERT', page: 4, found: true }] },
    evaluation: field('x'),
    results: field('x'),
    limitations: field({ stated: ['small dataset'], inferred: [] }),
    future_work: field('x'),
    research_type: field('evaluation')
  }
}

describe('SummaryFileSchema', () => {
  it('accepts a complete summary', () => {
    expect(SummaryFileSchema.parse(summary).fields.method.evidence[0].page).toBe(4)
  })

  it('rejects an unknown research type and a bad status', () => {
    expect(SummaryFileSchema.safeParse({ ...summary, fields: { ...summary.fields, research_type: field('essay') } }).success).toBe(false)
    expect(SummaryFileSchema.safeParse({ ...summary, fields: { ...summary.fields, tldr: { value: 'x', status: 'approved', evidence: [] } } }).success).toBe(false)
  })

  it('allows page-less evidence for web pages', () => {
    const s = { ...summary, fields: { ...summary.fields, tldr: { value: 'x', status: 'generated', evidence: [{ quote: 'q', page: null, found: false }] } } }
    expect(SummaryFileSchema.parse(s).fields.tldr.evidence[0].page).toBeNull()
  })
})

describe('ExtractionFormSchema', () => {
  it('accepts the four facet types and defaults value_aliases', () => {
    const form = ExtractionFormSchema.parse({
      facets: [
        { key: 'llm_usage', type: 'single', description: 'd', values: ['none', 'local'] },
        { key: 'task', type: 'multi', description: 'd', values: ['log_parsing'] },
        { key: 'traceability', type: 'text', description: 'd' },
        { key: 'relevance', type: 'scale', description: 'd', min: 1, max: 5 }
      ]
    })
    expect(form.value_aliases).toEqual({})
  })

  it('rejects keys and values that are not snake_case', () => {
    expect(ExtractionFormSchema.safeParse({ facets: [{ key: 'Task', type: 'text', description: 'd' }] }).success).toBe(false)
    expect(ExtractionFormSchema.safeParse({ facets: [{ key: 'task', type: 'multi', description: 'd', values: ['Log Parsing'] }] }).success).toBe(false)
  })
})

describe('ExtractionFileSchema', () => {
  it('accepts every facet entry shape', () => {
    const file = ExtractionFileSchema.parse({
      schema_version: 1,
      form_hash: 'abc',
      facets: {
        task: { values: ['log_parsing'], proposed: ['format_preserving_encryption'], status: 'generated', evidence: [] },
        llm_usage: { value: null, proposed: [], status: 'verified', evidence: [] },
        traceability: { text: 'none', status: 'generated', evidence: [] },
        relevance: { score: 4, justification: 'core', status: 'edited', evidence: [] }
      }
    })
    expect(file.facets.task.proposed).toEqual(['format_preserving_encryption'])
    expect(file.facets.traceability.proposed).toEqual([])
  })
})

describe('LlmConfigSchema', () => {
  it('fills defaults from an empty object', () => {
    expect(LlmConfigSchema.parse({})).toEqual({
      model: 'sonnet',
      auto_summarize: false,
      auto_suggest_relations: false,
      auto_suggest_facets: false,
      auto_suggest_facets_after: 10,
      max_input_chars: 400000,
      budget: { per_operation_usd: 0.5, per_batch_usd: 10, per_month_usd: null, per_facet_suggestion_usd: 2, per_chat_message_usd: 0.5, per_draft_usd: 1, per_cite_check_usd: 1, per_outline_usd: 0.5, per_style_usd: 0.5 }
    })
  })

  it('falls back to defaults when the block is invalid, so project.yaml still opens', () => {
    expect(LlmConfigSchema.parse({ model: 'gpt' }).model).toBe('sonnet')
    expect(LlmConfigSchema.parse('not a block').model).toBe('sonnet')
  })

  it('falls back field by field: one bad value keeps the others', () => {
    expect(
      LlmConfigSchema.parse({ model: 'gpt', auto_summarize: true, max_input_chars: 1000, budget: { per_operation_usd: -1, per_batch_usd: 3, per_month_usd: 20 } })
    ).toEqual({
      model: 'sonnet',
      auto_summarize: true,
      auto_suggest_relations: false,
      auto_suggest_facets: false,
      auto_suggest_facets_after: 10,
      max_input_chars: 1000,
      budget: { per_operation_usd: 0.5, per_batch_usd: 3, per_month_usd: 20, per_facet_suggestion_usd: 2, per_chat_message_usd: 0.5, per_draft_usd: 1, per_cite_check_usd: 1, per_outline_usd: 0.5, per_style_usd: 0.5 }
    })
    expect(LlmConfigSchema.parse({ model: 'opus', budget: 'oops' })).toMatchObject({ model: 'opus', budget: { per_operation_usd: 0.5, per_batch_usd: 10, per_month_usd: null } })
  })

  it('keeps auto_suggest_relations and falls back to false when invalid', () => {
    expect(LlmConfigSchema.parse({ auto_suggest_relations: true }).auto_suggest_relations).toBe(true)
    expect(LlmConfigSchema.parse({ auto_suggest_relations: 'yes' }).auto_suggest_relations).toBe(false)
  })

  it('reads the facet suggestion settings, each falling back on its own', () => {
    expect(LlmConfigSchema.parse({ auto_suggest_facets: true, auto_suggest_facets_after: 4, budget: { per_facet_suggestion_usd: 3 } })).toMatchObject({
      auto_suggest_facets: true,
      auto_suggest_facets_after: 4,
      budget: { per_facet_suggestion_usd: 3, per_operation_usd: 0.5 }
    })
    expect(LlmConfigSchema.parse({ auto_suggest_facets: 'yes', auto_suggest_facets_after: 0, budget: { per_facet_suggestion_usd: -1 } })).toMatchObject({
      auto_suggest_facets: false,
      auto_suggest_facets_after: 10,
      budget: { per_facet_suggestion_usd: 2 }
    })
    expect(COST_OPERATIONS).toEqual(['summarize', 'suggest_relations', 'suggest_facets', 'fill_facets', 'chat', 'screening', 'draft', 'cite_check', 'outline', 'style'])
  })

  it('reads the per-message chat cap, falling back on its own', () => {
    expect(LlmConfigSchema.parse({ budget: { per_chat_message_usd: 0.2 } }).budget).toMatchObject({ per_chat_message_usd: 0.2, per_operation_usd: 0.5 })
    expect(LlmConfigSchema.parse({ budget: { per_chat_message_usd: 0, per_batch_usd: 3 } }).budget).toMatchObject({ per_chat_message_usd: 0.5, per_batch_usd: 3 })
  })

  it('reads the writing caps, each falling back on its own', () => {
    expect(LlmConfigSchema.parse({ budget: { per_draft_usd: 2, per_style_usd: 0.2 } }).budget).toMatchObject({ per_draft_usd: 2, per_cite_check_usd: 1, per_outline_usd: 0.5, per_style_usd: 0.2 })
    expect(LlmConfigSchema.parse({ budget: { per_draft_usd: 0, per_cite_check_usd: 'x', per_outline_usd: 3 } }).budget).toMatchObject({ per_draft_usd: 1, per_cite_check_usd: 1, per_outline_usd: 3 })
  })
})

describe('ProjectConfigSchema', () => {
  it('adds default llm settings and keeps an extraction form untouched for separate validation', () => {
    const cfg = ProjectConfigSchema.parse({ schema_version: 1, name: 'T', extraction_form: { facets: 'not even valid' } })
    expect(cfg.llm.model).toBe('sonnet')
    expect(cfg.extraction_form).toEqual({ facets: 'not even valid' })
  })
})

describe('thesis context in project.yaml', () => {
  it('defaults to an empty context and falls back to it when invalid', () => {
    const empty = { title: '', description: '', research_questions: [], last_rq: 0 }
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T' }).thesis).toEqual(empty)
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T', thesis: { research_questions: [{ id: 'Q1', text: 'x' }] } }).thesis).toEqual(empty)
    const ok = { title: 'T', description: '', research_questions: [{ id: 'RQ1', text: 'x' }], last_rq: 0 }
    expect(ProjectConfigSchema.parse({ schema_version: 1, name: 'T', thesis: ok }).thesis).toEqual(ok)
  })
})
