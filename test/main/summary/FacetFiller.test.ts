import { describe, expect, it } from 'vitest'
import { FacetFiller } from '../../../src/main/summary/FacetFiller'
import { DEFAULT_EXTRACTION_FORM, formHashFor } from '../../../src/main/summary/extractionForm'
import type { CompleteRequest, CompleteResult, LlmProvider } from '../../../src/main/llm/LlmProvider'
import { editFacet, setFacetStatus } from '../../../src/main/summary/merge'
import { ConflictError } from '../../../src/main/project/errors'
import type { ExtractionForm, FacetDef } from '../../../src/shared/summary'
import { fillOutputFor, llmOutputFor, setupSummaries } from '../../helpers/llm'

const ID = 'he2017drain'
const DATA_SOURCE: FacetDef = { key: 'data_source', type: 'multi', description: 'Where the analyzed data comes from', values: ['production_logs', 'public_dataset'] }
const MATURITY: FacetDef = { key: 'maturity', type: 'scale', description: 'How mature the tool is', min: 1, max: 3 }
const WITH_SOURCE: ExtractionForm = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, DATA_SOURCE] }
const summaryResult: CompleteResult = { value: llmOutputFor(DEFAULT_EXTRACTION_FORM), costUsd: 0.03, model: 'claude-sonnet-5' }
const fillResult: CompleteResult = { value: fillOutputFor([DATA_SOURCE]), costUsd: 0.01, model: 'claude-haiku-5' }

/** A summarized paper; then the form gains `added` (data_source by default). */
async function setup(fill: CompleteResult | Error = fillResult, added: FacetDef[] = [DATA_SOURCE]) {
  const s = await setupSummaries({ responses: [summaryResult, fill] })
  await s.summarizer.summarize({ paperId: ID })
  await s.store.updateConfig({ extraction_form: { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, ...added] } })
  const filler = new FacetFiller({ store: s.store, cache: s.cache, provider: s.provider, budget: s.budget, ledger: s.ledger, now: () => new Date('2026-10-11T12:00:00.000Z') })
  return { ...s, filler }
}

describe('FacetFiller', () => {
  it('fills only the new facet, with evidence, and leaves the summary and every other entry as they were', async () => {
    const { store, filler, provider } = await setup()
    const before = await store.readExtraction(ID)
    if (!before?.ok) throw new Error('no classification')
    await store.writeExtraction(ID, setFacetStatus(before.value, 'task', 'verified'), before.hash)
    const verified = await store.readExtraction(ID)
    const summaryBefore = await store.readSummary(ID)
    if (!verified?.ok || !summaryBefore?.ok) throw new Error('unreadable')

    expect(await filler.fill({ paperId: ID })).toEqual({ filled: ['data_source'], costUsd: 0.01 })

    const after = await store.readExtraction(ID)
    const summaryAfter = await store.readSummary(ID)
    if (!after?.ok || !summaryAfter?.ok) throw new Error('unreadable')
    expect(after.value.facets.data_source).toMatchObject({
      values: ['production_logs'],
      proposed: [],
      status: 'generated',
      evidence: [{ quote: 'we fine-tune a BERT model', page: 1, found: true }],
      origin: { model: 'claude-haiku-5', at: '2026-10-11T12:00:00.000Z', prompt_version: 1 }
    })
    const { data_source: _filled, ...rest } = after.value.facets
    expect(rest).toEqual(verified.value.facets)
    expect(after.value.facets.task.status).toBe('verified')
    expect(after.value.thesis_relation).toEqual(verified.value.thesis_relation)
    expect(after.value.form_hash).toBe(formHashFor(WITH_SOURCE, Object.keys(after.value.facets)))
    expect(after.value.form_hash).not.toBe(verified.value.form_hash)
    expect(summaryAfter.value).toEqual(summaryBefore.value)
    expect(provider.calls[1].schema).toMatchObject({ properties: { facets: { required: ['data_source'] } } })
    expect(provider.calls[1].system).toContain('- data_source (zero or more values)')
    expect((await store.readCosts()).map((c) => c.operation)).toEqual(['summarize', 'fill_facets'])
  })

  it('spends nothing when the paper has every facet, and refuses a stale summary or an over-long text', async () => {
    const { store, filler, provider } = await setup()
    await store.updateConfig({ extraction_form: DEFAULT_EXTRACTION_FORM })
    expect(await filler.fill({ paperId: ID })).toEqual({ filled: [], costUsd: 0 })
    const reworded = { ...WITH_SOURCE, facets: WITH_SOURCE.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f)) }
    await store.updateConfig({ extraction_form: reworded })
    await expect(filler.fill({ paperId: ID })).rejects.toMatchObject({ code: 'summary_outdated' })
    await store.updateConfig({ extraction_form: WITH_SOURCE, llm: { ...store.config.llm, max_input_chars: 10 } })
    await expect(filler.fill({ paperId: ID })).rejects.toMatchObject({ code: 'too_long' })
    expect(provider.calls).toHaveLength(1)
  })

  it('retries an invalid answer once, then fails and charges both calls', async () => {
    const { store, filler } = await setup({ value: { facets: {} }, costUsd: 0.01, model: 'm' })
    await expect(filler.fill({ paperId: ID })).rejects.toMatchObject({ code: 'llm_invalid_output' })
    expect((await store.readCosts()).map((c) => c.operation)).toEqual(['summarize', 'fill_facets', 'fill_facets'])
    const after = await store.readExtraction(ID)
    expect(after?.ok && after.value.facets.data_source).toBeFalsy()
  })

  it('keeps a facet the user filled by hand while Claude answered, and writes only the one still missing', async () => {
    const both: CompleteResult = { value: fillOutputFor([DATA_SOURCE, MATURITY]), costUsd: 0.01, model: 'claude-haiku-5' }
    const s = await setup(both, [DATA_SOURCE, MATURITY])
    const form = { ...DEFAULT_EXTRACTION_FORM, facets: [...DEFAULT_EXTRACTION_FORM.facets, DATA_SOURCE, MATURITY] }
    // The user edits data_source by hand during the call.
    const provider: LlmProvider = {
      complete: async (req: CompleteRequest) => {
        const e = await s.store.readExtraction(ID)
        if (!e?.ok) throw new Error('unreadable')
        await s.store.writeExtraction(ID, editFacet(e.value, form, 'data_source', { values: ['public_dataset'] }), e.hash)
        return s.provider.complete(req)
      },
      runAgent: (req) => s.provider.runAgent(req)
    }
    const filler = new FacetFiller({ store: s.store, cache: s.cache, provider, budget: s.budget, ledger: s.ledger })
    expect(await filler.fill({ paperId: ID })).toEqual({ filled: ['maturity'], costUsd: 0.01 })
    const after = await s.store.readExtraction(ID)
    if (!after?.ok) throw new Error('unreadable')
    expect(after.value.facets.data_source).toMatchObject({ values: ['public_dataset'], status: 'edited' })
    expect(after.value.facets.maturity).toMatchObject({ score: 1, status: 'generated' })
    expect(after.value.form_hash).toBe(formHashFor(form, Object.keys(after.value.facets)))
  })

  it('writes nothing when the form changed a facet the paper has while Claude answered', async () => {
    const s = await setup()
    const reworded = { ...WITH_SOURCE, facets: WITH_SOURCE.facets.map((f) => (f.key === 'rigor' ? { ...f, description: 'Changed' } : f)) }
    const provider: LlmProvider = {
      complete: async (req: CompleteRequest) => {
        await s.store.updateConfig({ extraction_form: reworded })
        return s.provider.complete(req)
      },
      runAgent: (req) => s.provider.runAgent(req)
    }
    const filler = new FacetFiller({ store: s.store, cache: s.cache, provider, budget: s.budget, ledger: s.ledger })
    const before = await s.store.readExtraction(ID)
    await expect(filler.fill({ paperId: ID })).rejects.toMatchObject({ code: 'summary_outdated' })
    const after = await s.store.readExtraction(ID)
    expect(after?.ok && after.value).toEqual(before?.ok && before.value)
  })
  it('reports the fill as done when the classification was written but summary.md keeps conflicting', async () => {
    const s = await setup()
    const summaryBefore = await s.store.readSummary(ID)
    let attempts = 0
    s.store.writeSummary = async () => {
      attempts++
      throw new ConflictError('summary.md')
    }
    expect(await s.filler.fill({ paperId: ID })).toEqual({ filled: ['data_source'], costUsd: 0.01 })
    expect(attempts).toBe(2)
    const after = await s.store.readExtraction(ID)
    if (!after?.ok) throw new Error('unreadable')
    expect(after.value.facets.data_source).toMatchObject({ values: ['production_logs'], status: 'generated' })
    expect(after.value.form_hash).toBe(formHashFor(WITH_SOURCE, Object.keys(after.value.facets)))
    expect((await s.store.readSummary(ID))?.hash).toBe(summaryBefore?.hash)
  })

  it('writes nothing when the fill is cancelled while Claude answers', async () => {
    const s = await setup()
    const controller = new AbortController()
    const provider: LlmProvider = {
      complete: async (req: CompleteRequest) => {
        const result = await s.provider.complete(req)
        controller.abort()
        return result
      },
      runAgent: (req) => s.provider.runAgent(req)
    }
    const filler = new FacetFiller({ store: s.store, cache: s.cache, provider, budget: s.budget, ledger: s.ledger })
    const before = await s.store.readExtraction(ID)
    await expect(filler.fill({ paperId: ID, signal: controller.signal })).rejects.toThrow()
    const after = await s.store.readExtraction(ID)
    expect(after?.ok && after.value).toEqual(before?.ok && before.value)
    expect((await s.store.readCosts()).map((c) => c.operation)).toEqual(['summarize', 'fill_facets'])
  })
})
