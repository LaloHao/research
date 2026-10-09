import { describe, expect, it } from 'vitest'
import { outputJsonSchema, parseLlmOutput, toGeneratedFiles, type LlmOutput } from '../../../src/main/summary/llmOutput'
import type { ExtractionForm } from '../../../src/shared/summary'

const form: ExtractionForm = {
  facets: [
    { key: 'llm_usage', type: 'single', description: 'd', values: ['none', 'local'] },
    { key: 'technique', type: 'multi', description: 'd', values: ['ner', 'pseudonymization'] },
    { key: 'traceability', type: 'text', description: 'd' },
    { key: 'relevance', type: 'scale', description: 'd', min: 1, max: 5 }
  ],
  value_aliases: { technique: { tokenization: 'pseudonymization' } }
}

const ev = [{ quote: 'we fine-tune BERT', page: 4 }]
const text = (value: string) => ({ value, evidence: ev })

const validOutput: LlmOutput = {
  fields: {
    tldr: text('NER for logs'),
    problem: text('PII in logs'),
    contribution: text('pipeline'),
    method: text('BERT'),
    evaluation: text('3 datasets'),
    results: text('F1 0.93'),
    limitations: { value: { stated: ['English only'], inferred: [] }, evidence: [] },
    future_work: text('more languages'),
    research_type: { value: 'evaluation', evidence: [] }
  },
  facets: {
    llm_usage: { value: null, proposed: ['hybrid'], evidence: [] },
    technique: { values: ['ner'], proposed: ['tokenization', 'Format Preserving Encryption'], evidence: ev },
    traceability: { text: 'not addressed', evidence: [] },
    relevance: { score: 4, justification: 'core topic', evidence: [] }
  }
}

describe('outputJsonSchema', () => {
  const schema = outputJsonSchema(form) as any

  it('requires every field and facet and forbids extra keys', () => {
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.fields.required).toContain('research_type')
    expect(schema.properties.facets.required).toEqual(['llm_usage', 'technique', 'traceability', 'relevance'])
  })

  it('restricts allowed values but leaves proposals free', () => {
    const technique = schema.properties.facets.properties.technique
    expect(technique.properties.values.items.enum).toEqual(['ner', 'pseudonymization'])
    expect(technique.properties.proposed.items).toEqual({ type: 'string' })
    expect(schema.properties.facets.properties.relevance.properties.score.enum).toEqual([1, 2, 3, 4, 5])
  })

  it('never uses keywords structured output may reject', () => {
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|minLength|maxLength|pattern/)
  })
})

describe('parseLlmOutput', () => {
  it('accepts a valid answer', () => {
    expect(parseLlmOutput(validOutput, form).ok).toBe(true)
  })

  it('explains what is wrong', () => {
    const bad = { ...validOutput, facets: { ...validOutput.facets, relevance: { score: 9, justification: 'x', evidence: [] } } }
    const r = parseLlmOutput(bad, form)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('relevance')
  })
})

describe('toGeneratedFiles', () => {
  const meta = { model: 'sonnet', at: '2026-10-08T00:00:00.000Z', cost_usd_est: 0.04, prompt_version: 1, language: 'en' }
  const { summary, extraction } = toGeneratedFiles(validOutput, form, 'hash1', meta)

  it('marks every field generated, with evidence still unchecked', () => {
    expect(summary.fields.method).toEqual({ value: 'BERT', status: 'generated', evidence: [{ quote: 'we fine-tune BERT', page: 4, found: false }] })
    expect(summary.generated).toEqual(meta)
  })

  it('applies aliases and keeps genuine proposals in snake_case', () => {
    expect(extraction.facets.technique).toMatchObject({ values: ['ner', 'pseudonymization'], proposed: ['format_preserving_encryption'] })
    expect(extraction.facets.llm_usage).toMatchObject({ value: null, proposed: ['hybrid'] })
    expect(extraction.facets.relevance).toMatchObject({ score: 4, justification: 'core topic', proposed: [] })
    expect(extraction.form_hash).toBe('hash1')
  })

  it('drops empty quotes', () => {
    const out = { ...validOutput, fields: { ...validOutput.fields, tldr: { value: 'x', evidence: [{ quote: '  ', page: 1 }] } } }
    expect(toGeneratedFiles(out, form, 'h', meta).summary.fields.tldr.evidence).toEqual([])
  })
})
