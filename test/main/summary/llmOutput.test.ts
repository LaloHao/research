import { describe, expect, it } from 'vitest'
import { outputJsonSchema, parseLlmOutput, toGeneratedFiles, type LlmOutput } from '../../../src/main/summary/llmOutput'
import type { ExtractionForm } from '../../../src/shared/summary'
import { thesisHash } from '../../../src/main/summary/thesis'
import { sampleThesis } from '../../helpers/summaries'

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
    expect(summary.fields.method).toEqual({
      value: 'BERT',
      status: 'generated',
      evidence: [{ quote: 'we fine-tune BERT', page: 4, found: false }],
      origin: { model: 'sonnet', at: meta.at, prompt_version: 1 }
    })
    expect(summary.generated).toEqual(meta)
  })

  it('stamps every field and facet with the origin taken from meta', () => {
    const origin = { model: meta.model, at: meta.at, prompt_version: meta.prompt_version }
    for (const field of Object.values(summary.fields)) expect(field.origin).toEqual(origin)
    for (const facet of Object.values(extraction.facets)) expect(facet.origin).toEqual(origin)
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

  it('treats a non-positive page as unknown', () => {
    const out = {
      ...validOutput,
      fields: {
        ...validOutput.fields,
        tldr: {
          value: 'x',
          evidence: [
            { quote: 'zero page', page: 0 },
            { quote: 'negative page', page: -3 }
          ]
        }
      }
    }
    expect(toGeneratedFiles(out, form, 'h', meta).summary.fields.tldr.evidence).toEqual([
      { quote: 'zero page', page: null, found: false },
      { quote: 'negative page', page: null, found: false }
    ])
  })
})

describe('thesis relation', () => {
  const meta = { model: 'sonnet', at: '2026-10-08T00:00:00.000Z', cost_usd_est: 0.04, prompt_version: 1, language: 'en' }
  const relation = { text: 'informs RQ1', research_questions: ['RQ1'], score: 4, justification: 'addresses RQ1', evidence: ev }
  const withRelation: LlmOutput = { ...validOutput, thesis_relation: relation }

  it('is absent from the schema without a thesis context', () => {
    const schema = outputJsonSchema(form) as any
    expect(schema.properties.thesis_relation).toBeUndefined()
    expect(schema.required).toEqual(['fields', 'facets'])
    const empty = outputJsonSchema(form, { title: '', description: '', research_questions: [] }) as any
    expect(empty.properties.thesis_relation).toBeUndefined()
    expect(JSON.stringify(empty)).toBe(JSON.stringify(schema))
  })

  it('restricts research questions to the thesis ids and the score to 1–5', () => {
    const schema = outputJsonSchema(form, sampleThesis) as any
    expect(schema.required).toEqual(['fields', 'facets', 'thesis_relation'])
    const rel = schema.properties.thesis_relation
    expect(rel.additionalProperties).toBe(false)
    expect(rel.required).toEqual(['text', 'research_questions', 'score', 'justification', 'evidence'])
    expect(rel.properties.research_questions.items.enum).toEqual(['RQ1', 'RQ2'])
    expect(rel.properties.score).toEqual({ type: 'integer', enum: [1, 2, 3, 4, 5] })
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|minLength|maxLength|pattern/)
  })

  it('leaves research questions free when the thesis has none', () => {
    const schema = outputJsonSchema(form, { ...sampleThesis, research_questions: [] }) as any
    expect(schema.properties.thesis_relation.properties.research_questions).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('requires the relation only with a context', () => {
    expect(parseLlmOutput(validOutput, form, sampleThesis).ok).toBe(false)
    expect(parseLlmOutput(withRelation, form, sampleThesis).ok).toBe(true)
    const bad = { ...withRelation, thesis_relation: { ...relation, score: 6 } }
    expect(parseLlmOutput(bad, form, sampleThesis).ok).toBe(false)
  })

  it('writes the relation with its origin and the thesis hash', () => {
    const { extraction } = toGeneratedFiles(withRelation, form, 'hash1', meta, sampleThesis)
    expect(extraction.thesis_relation).toEqual({
      text: 'informs RQ1',
      research_questions: ['RQ1'],
      score: 4,
      justification: 'addresses RQ1',
      status: 'generated',
      evidence: [{ quote: 'we fine-tune BERT', page: 4, found: false }],
      origin: { model: 'sonnet', at: meta.at, prompt_version: 1 }
    })
    expect(extraction.thesis_hash).toBe(thesisHash(sampleThesis))
  })

  it('drops unknown questions, and all of them when the thesis has none', () => {
    const out = { ...withRelation, thesis_relation: { ...relation, research_questions: ['RQ2', 'RQ7', 'RQ2'] } }
    expect(toGeneratedFiles(out, form, 'h', meta, sampleThesis).extraction.thesis_relation?.research_questions).toEqual(['RQ2'])
    const none = { ...sampleThesis, research_questions: [] }
    expect(toGeneratedFiles(withRelation, form, 'h', meta, none).extraction.thesis_relation?.research_questions).toEqual([])
  })

  it('writes neither the relation nor the hash without a context', () => {
    const { extraction } = toGeneratedFiles(withRelation, form, 'h', meta)
    expect(extraction).not.toHaveProperty('thesis_relation')
    expect(extraction).not.toHaveProperty('thesis_hash')
  })
})
