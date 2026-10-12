import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { ScreeningSuggester } from '../../../src/main/mapping/ScreeningSuggester'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { FakeLlmProvider, type AgentResponse } from '../../helpers/llm'
import { hexId, protocolFile, record } from '../../helpers/mappings'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'
import { LlmError, type CompleteResult } from '../../../src/main/llm/LlmProvider'

const DEVICE = '11111111-1111-1111-1111-111111111111'
const R1 = hexId('r', 1)
const R2 = hexId('r', 2)
const MODEL = 'claude-sonnet-5'

async function setup(responses: (CompleteResult | Error)[], agent: AgentResponse[] = [], onClose: () => void = () => undefined) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  await store.updateConfig({ content_language: 'es' })
  await store.writePaper(samplePaper(), null)
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  cache.upsertPaper(samplePaper(), 'h', true)
  cache.setText('he2017drain', 't', 'ok', [{ index: 0, page: 3, text: 'We evaluate the parser on five real-world log datasets from production systems.' }])
  const provider = new FakeLlmProvider(responses, agent)
  const ledger = new CostLedger(store, DEVICE, () => new Date('2026-10-12T12:00:00.000Z'))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal())
  const toolRuns: number[] = []
  const suggester = new ScreeningSuggester({
    store,
    cache,
    provider,
    budget,
    ledger,
    startTools: async (o) => {
      toolRuns.push(o.maxToolCalls)
      return { url: 'http://127.0.0.1:1/mcp', token: 't', calls: () => [], close: async () => void onClose() }
    }
  })
  return { store, cache, provider, suggester, toolRuns, budgetCheck: () => ledger.monthTotal() }
}

const answer = (value: unknown, costUsd = 0.03): CompleteResult => ({ value, costUsd, model: MODEL })

describe('ScreeningSuggester, title and abstract', () => {
  it('makes one structured call for the batch, checks each quote against the record, and logs the cost as screening', async () => {
    const value = {
      suggestions: [
        { record: R1, decision: 'include', criterion: 'I1', justification: 'Propone un parser de logs.', quote: 'online log parser' },
        { record: R2, decision: 'exclude', criterion: 'E1', justification: 'No trata de logs.', quote: 'a sentence that is not there' },
        { record: hexId('r', 9), decision: 'include', criterion: null, justification: 'x', quote: null }
      ]
    }
    const { suggester, provider, store } = await setup([answer(value)])
    const out = await suggester.titleAbstract({ protocol: protocolFile(), records: [record(), record({ id: R2, title: 'Other' })], batchId: 'b1' })
    expect(out).toMatchObject({ dropped: 1, costUsd: 0.03, model: MODEL })
    expect(out.suggestions.map((s) => [s.record, s.decision, s.found])).toEqual([
      [R1, 'include', true],
      [R2, 'exclude', false]
    ])
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]).toMatchObject({ maxUsd: 0.5, model: 'sonnet' })
    expect(provider.calls[0].system).toContain('Write the justifications in Spanish')
    expect(provider.calls[0].input).toContain(`<record id="${R2}">`)
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'screening', paper_id: '', batch_id: 'b1', cost_usd: 0.03 })])
  })

  it('asks once more when the answer has the wrong shape, then gives up', async () => {
    const ok = { suggestions: [{ record: R1, decision: 'uncertain', criterion: null, justification: 'Sin resumen.', quote: null }] }
    const retried = await setup([answer({ wrong: true }, 0.01), answer(ok)])
    expect((await retried.suggester.titleAbstract({ protocol: protocolFile(), records: [record()] })).suggestions).toHaveLength(1)
    expect(retried.provider.calls[1].input).toContain('did not match the required structure')
    const failing = await setup([answer({ wrong: true }, 0.01)])
    await expect(failing.suggester.titleAbstract({ protocol: protocolFile(), records: [record()] })).rejects.toMatchObject({ code: 'llm_invalid_output' })
    expect((await failing.store.readCosts()).map((c) => c.cost_usd)).toEqual([0.01, 0.01])
  })

  it('charges a cancelled call at its estimate and passes no tools', async () => {
    const stopped = Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { costUsd: 0.5, estimated: true })
    const { suggester, provider, store } = await setup([stopped])
    await expect(suggester.titleAbstract({ protocol: protocolFile(), records: [record()], batchId: 'b3' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.calls[0]).not.toHaveProperty('mcp')
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'screening', batch_id: 'b3', cost_usd: 0.5, estimated: true })])
  })

  it('takes between one and twenty records', async () => {
    const { suggester, provider } = await setup([answer({ suggestions: [] })])
    await expect(suggester.titleAbstract({ protocol: protocolFile(), records: [] })).rejects.toThrow()
    const many = Array.from({ length: 21 }, (_, i) => record({ id: hexId('r', i + 1) }))
    await expect(suggester.titleAbstract({ protocol: protocolFile(), records: many })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })
})

describe('ScreeningSuggester, full text', () => {
  it('runs an agent with the read-only library tools and locates the quote in the paper', async () => {
    const { suggester, provider, toolRuns, store } = await setup(
      [],
      [answer({ decision: 'include', criterion: 'I1', justification: 'Evalúa un parser.', quote: 'five real-world log datasets', page: 1 }, 0.12)]
    )
    const out = await suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'he2017drain', batchId: 'b2' })
    expect(out.suggestion).toEqual({ record: R1, decision: 'include', criterion: 'I1', justification: 'Evalúa un parser.', quote: 'five real-world log datasets', page: 3, found: true })
    expect(toolRuns).toEqual([8])
    expect(provider.agentCalls[0]).toMatchObject({ maxTurns: 8, mcp: { name: 'library' } })
    expect(provider.agentCalls[0].input).toContain('paper="he2017drain"')
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'screening', paper_id: 'he2017drain', cost_usd: 0.12 })])
  })

  it('needs a library paper with its text', async () => {
    const { suggester, provider } = await setup([], [answer({})])
    await expect(suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'nope2020x' })).rejects.toMatchObject({ code: 'file_problem' })
    const noText = await setup([], [answer({})])
    noText.cache.setText('he2017drain', 't', 'no_text', [])
    await expect(noText.suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'no_text' })
    expect([...provider.agentCalls, ...noText.provider.agentCalls]).toHaveLength(0)
  })

  it('charges a timed-out run at its estimate and closes the tools', async () => {
    let closed = 0
    const { suggester, store, budgetCheck } = await setup([], [new LlmError('llm_timeout', 0.5, { estimated: true })], () => closed++)
    await expect(suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'he2017drain', batchId: 'b4' })).rejects.toMatchObject({ code: 'llm_timeout' })
    expect(closed).toBe(1)
    expect(await store.readCosts()).toEqual([expect.objectContaining({ operation: 'screening', paper_id: 'he2017drain', cost_usd: 0.5, estimated: true })])
    expect(await budgetCheck()).toBe(0.5)
  })

  it('refuses a malformed answer after logging its cost, and marks an absent quote as not found', async () => {
    const bad = await setup([], [answer({ decision: 'exclude', criterion: 'I1', justification: 'x', quote: null, page: null }, 0.07)])
    await expect(bad.suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'he2017drain' })).rejects.toMatchObject({ code: 'llm_invalid_output' })
    expect((await bad.store.readCosts()).map((c) => c.cost_usd)).toEqual([0.07])
    const none = await setup([], [answer({ decision: 'uncertain', criterion: null, justification: 'x', quote: null, page: null })])
    expect((await none.suggester.fullText({ protocol: protocolFile(), record: record(), paperId: 'he2017drain' })).suggestion).toMatchObject({ quote: null, found: false })
  })
})
