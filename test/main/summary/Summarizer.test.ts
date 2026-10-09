import { describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { PROMPT_VERSION } from '../../../src/main/summary/prompt'
import { llmOutputFor, setupSummaries } from '../../helpers/llm'
import { sampleThesis } from '../../helpers/summaries'
import { thesisHash } from '../../../src/main/summary/thesis'

const answer = (costUsd: number, change?: (o: ReturnType<typeof llmOutputFor>) => void) => {
  const value = llmOutputFor(DEFAULT_EXTRACTION_FORM)
  change?.(value)
  return { value, costUsd, model: 'claude-sonnet-5' }
}

describe('Summarizer', () => {
  it('writes summary.md and extraction.yaml with checked evidence and records the cost', async () => {
    const { store, summarizer, provider, ledger } = await setupSummaries()
    const r = await summarizer.summarize({ paperId: 'he2017drain' })
    expect(r.costUsd).toBe(0.03)
    expect(r.evidenceFound).toBe(r.evidenceTotal)
    const summary = await store.readSummary('he2017drain')
    expect(summary).toMatchObject({ ok: true, value: { generated: { model: 'claude-sonnet-5', prompt_version: PROMPT_VERSION, language: 'en', cost_usd_est: 0.03 } } })
    if (summary?.ok) expect(summary.value.fields.method.evidence[0]).toMatchObject({ page: 1, found: true })
    expect(await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toContain('## Method')
    expect((await store.readExtraction('he2017drain'))?.ok).toBe(true)
    expect(await ledger.monthTotal()).toBeCloseTo(0.03)
    const call = provider.calls[0]
    expect(call.input).toContain('<paper title="Drain: An Online Log Parsing Approach with Fixed Depth Tree">')
    expect(call.input).toContain('[p.1]')
    expect(call.model).toBe('sonnet')
    expect(call.maxUsd).toBe(0.5)
    expect(call.system).toContain('sanitization_technique')
    expect(call.system).not.toContain('thesis_relation')
    expect((call.schema as any).properties.thesis_relation).toBeUndefined()
    const extraction = await store.readExtraction('he2017drain')
    expect(extraction?.ok && extraction.value).not.toHaveProperty('thesis_relation')
    expect(extraction?.ok && extraction.value).not.toHaveProperty('thesis_hash')
  })

  it('with a thesis context in project.yaml, sends the thesis block and writes the relation', async () => {
    const { store, summarizer, provider } = await setupSummaries({ thesis: sampleThesis })
    const r = await summarizer.summarize({ paperId: 'he2017drain' })
    const call = provider.calls[0]
    expect(call.system).toContain(sampleThesis.title)
    expect(call.system).toContain('RQ1: Which sanitization techniques preserve utility?')
    expect((call.schema as any).properties.thesis_relation.properties.research_questions.items.enum).toEqual(['RQ1', 'RQ2'])
    const extraction = await store.readExtraction('he2017drain')
    if (!extraction?.ok) throw new Error('no extraction')
    expect(extraction.value.thesis_hash).toBe(thesisHash(sampleThesis))
    expect(extraction.value.thesis_relation).toMatchObject({
      text: 'relation text',
      research_questions: ['RQ1'],
      score: 4,
      status: 'generated',
      origin: { model: 'claude-sonnet-5', prompt_version: PROMPT_VERSION }
    })
    expect(extraction.value.thesis_relation?.evidence[0]).toMatchObject({ page: 1, found: true })
    expect(r.evidenceFound).toBe(r.evidenceTotal)
    expect(await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toContain('## Relation to the thesis')
  })

  it('uses a model given per run instead of the project default, and records the resolved id as origin', async () => {
    const { store, summarizer, provider } = await setupSummaries({ responses: [answer(0.02)] })
    await summarizer.summarize({ paperId: 'he2017drain', model: 'haiku' })
    expect(provider.calls[0].model).toBe('haiku')
    const summary = await store.readSummary('he2017drain')
    expect(summary?.ok && summary.value.generated.model).toBe('claude-sonnet-5')
    expect(summary?.ok && summary.value.fields.tldr.origin?.model).toBe('claude-sonnet-5')
  })

  it('keeps the origin of the first run on a verified field after regenerating with another model', async () => {
    const second = answer(0.01, (o) => {
      o.fields.method.value = 'regenerated method'
    })
    const { store, summarizer } = await setupSummaries({ responses: [answer(0.03), second] })
    await summarizer.summarize({ paperId: 'he2017drain' })
    const first = await store.readSummary('he2017drain')
    if (!first?.ok) throw new Error('no summary')
    const verified = { ...first.value, fields: { ...first.value.fields, tldr: { ...first.value.fields.tldr, status: 'verified' as const } } }
    await store.writeSummary('he2017drain', verified, 'x', first.hash)
    const firstOrigin = first.value.fields.tldr.origin
    await summarizer.summarize({ paperId: 'he2017drain', model: 'opus' })
    const after = await store.readSummary('he2017drain')
    expect(after?.ok && after.value.fields.tldr.origin).toEqual(firstOrigin)
    expect(after?.ok && after.value.fields.method.origin?.model).toBe('claude-sonnet-5')
  })

  it('never overwrites a verified field when regenerating', async () => {
    const second = answer(0.01, (o) => {
      o.fields.tldr.value = 'regenerated'
      o.fields.method.value = 'regenerated method'
    })
    const { store, summarizer } = await setupSummaries({ responses: [answer(0.03), second] })
    await summarizer.summarize({ paperId: 'he2017drain' })
    const first = await store.readSummary('he2017drain')
    if (!first?.ok) throw new Error('no summary')
    const verified = { ...first.value, fields: { ...first.value.fields, tldr: { ...first.value.fields.tldr, value: 'checked by me', status: 'verified' as const } } }
    await store.writeSummary('he2017drain', verified, 'x', first.hash)
    await summarizer.summarize({ paperId: 'he2017drain' })
    const after = await store.readSummary('he2017drain')
    expect(after?.ok && after.value.fields.tldr.value).toBe('checked by me')
    expect(after?.ok && after.value.fields.method.value).toBe('regenerated method')
  })

  it('retries once with the validation error, then succeeds', async () => {
    const { summarizer, provider } = await setupSummaries({
      responses: [{ value: { nonsense: true }, costUsd: 0.01, model: 'm' }, answer(0.02)]
    })
    const r = await summarizer.summarize({ paperId: 'he2017drain' })
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[1].input).toContain('did not match the required structure')
    expect(r.costUsd).toBeCloseTo(0.03)
  })

  it('fails with llm_invalid_output after two invalid answers, keeping their cost', async () => {
    const { summarizer, ledger } = await setupSummaries({ responses: [{ value: {}, costUsd: 0.01, model: 'm' }] })
    await expect(summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'llm_invalid_output' })
    expect(await ledger.monthTotal()).toBeCloseTo(0.02)
  })

  it('records the cost of a provider error and rethrows it', async () => {
    const { summarizer, ledger } = await setupSummaries({ responses: [new LlmError('budget_exceeded', 0.5)] })
    await expect(summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(await ledger.monthTotal()).toBeCloseTo(0.5)
  })

  it('refuses without text, with an invalid form, or when the text is too long unless forced', async () => {
    const noText = await setupSummaries()
    noText.cache.setText('he2017drain', null, 'no_text', [])
    await expect(noText.summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'no_text' })

    const noForm = await setupSummaries({ form: null })
    await expect(noForm.summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'invalid_form' })

    const long = await setupSummaries()
    await long.store.updateConfig({ llm: { ...long.store.config.llm, max_input_chars: 50 } })
    await expect(long.summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'too_long' })
    await expect(long.summarizer.summarize({ paperId: 'he2017drain', force: true })).resolves.toBeDefined()
    expect(long.provider.calls[0].input.length).toBeLessThan(200)
  })

  it('does not call Claude when the batch budget is spent', async () => {
    const { summarizer, provider } = await setupSummaries({ perBatchUsd: 0.02 })
    await summarizer.summarize({ paperId: 'he2017drain', batchId: 'b' })
    await expect(summarizer.summarize({ paperId: 'he2017drain', batchId: 'b' })).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(provider.calls).toHaveLength(1)
  })

  it('never overwrites an unreadable summary.md, and never calls Claude for it', async () => {
    const { store, summarizer, provider } = await setupSummaries()
    await writeFile(join(store.paperDir('he2017drain'), 'summary.md'), '---\n<<<<<<< HEAD\n')
    await expect(summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'file_problem' })
    expect(await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toBe('---\n<<<<<<< HEAD\n')
    expect(provider.calls).toHaveLength(0)
  })

  it('never overwrites an unreadable extraction.yaml, and never calls Claude for it', async () => {
    const { store, summarizer, provider } = await setupSummaries()
    await writeFile(join(store.paperDir('he2017drain'), 'extraction.yaml'), '---\n<<<<<<< HEAD\n')
    await expect(summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'file_problem' })
    expect(await readFile(join(store.paperDir('he2017drain'), 'extraction.yaml'), 'utf8')).toBe('---\n<<<<<<< HEAD\n')
    expect(provider.calls).toHaveLength(0)
  })

  it('fails with file_problem (never a raw ENOENT) when the paper folder is missing', async () => {
    const { store, summarizer, provider } = await setupSummaries()
    await rm(store.paperDir('he2017drain'), { recursive: true, force: true })
    await expect(summarizer.summarize({ paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'file_problem' })
    expect(provider.calls).toHaveLength(0)
  })
})
