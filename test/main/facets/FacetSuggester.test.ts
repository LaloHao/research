import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { FacetSuggester } from '../../../src/main/facets/FacetSuggester'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { LlmError, type AgentRequest } from '../../../src/main/llm/LlmProvider'
import { MapService } from '../../../src/main/map/MapService'
import { startLibraryMcpServer, type LibraryMcpHandle, type LibraryMcpOptions } from '../../../src/main/mcp/LibraryMcpServer'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { facetAgentResult, newFacetSuggestion, newValueSuggestion } from '../../helpers/facets'
import { FakeLlmProvider, type AgentResponse } from '../../helpers/llm'
import { callTools, listTools } from '../../helpers/mcp'
import { LOGHUB_ID, seedPair } from '../../helpers/pair'
import { NOW } from '../../helpers/relations'
import { sampleThesis } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

const DEVICE = '11111111-1111-1111-1111-111111111111'

/** Drain and Loghub with the default form and a thesis; Loghub's classification proposes regex_rules. */
async function setup(agent: AgentResponse[], opts: { form?: boolean; startTools?: (o: LibraryMcpOptions) => Promise<LibraryMcpHandle> } = {}) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  if (opts.form !== false) await store.updateConfig({ extraction_form: DEFAULT_EXTRACTION_FORM, thesis: sampleThesis })
  await store.writeExtraction(
    LOGHUB_ID,
    { schema_version: 1, form_hash: 'h', facets: { sanitization_technique: { values: ['ner'], proposed: ['regex_rules'], status: 'generated', evidence: [] } } },
    null
  )
  const provider = new FakeLlmProvider([], agent)
  const ledger = new CostLedger(store, DEVICE, () => new Date(NOW))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal(), 0.05, { suggest_facets: 0.5 })
  const map = new MapService({ store, cache })
  const servers: LibraryMcpHandle[] = []
  const suggester = new FacetSuggester({
    store,
    cache,
    provider,
    budget,
    ledger,
    startTools:
      opts.startTools ??
      (async (o) => {
        const server = await startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: null }), o)
        servers.push(server)
        return server
      }),
    now: () => new Date(NOW)
  })
  return { store, cache, provider, budget, ledger, suggester, servers }
}

describe('FacetSuggester', () => {
  it('lets the agent read the library through the read-only tools and returns checked suggestions', async () => {
    const { suggester, provider, store } = await setup([
      async (req: AgentRequest) => {
        const [overview, page] = await callTools(req.mcp, [
          { name: 'facet_overview', arguments: {} },
          { name: 'list_papers', arguments: {} }
        ])
        expect(JSON.parse(overview.text).facets[0]).toMatchObject({ key: 'sanitization_technique', proposed: [{ value: 'regex_rules', papers: [LOGHUB_ID] }] })
        expect(JSON.parse(page.text).total).toBe(2)
        // Only the library's read-only tools are offered.
        expect((await listTools(req.mcp)).map((t) => t.name).sort()).toEqual([
          'facet_overview',
          'find_in_paper',
          'get_citations',
          'get_neighbours',
          'get_paper',
          'get_summary',
          'list_papers',
          'read_pages',
          'search_similar',
          'search_text'
        ])
        return facetAgentResult()
      }
    ])
    const result = await suggester.suggest({ existing: [] })
    expect(result.suggestions.map((s) => s.id)).toEqual(['new_facet__data_source', 'new_value__data_type__metrics', 'alias__sanitization_technique__rules_regex'])
    expect(result.suggestions[0]).toMatchObject({
      kind: 'new_facet',
      status: 'suggested',
      updated_at: NOW,
      origin: { model: 'claude-sonnet-5', at: NOW, prompt_version: 1 },
      examples: [{ paper: LOGHUB_ID, value: 'public_dataset', page: 1, found: true }]
    })
    expect(result).toMatchObject({ costUsd: 0.4, toolCalls: 2, dropped: [], evidenceFound: 2, evidenceTotal: 2, model: 'claude-sonnet-5' })
    const req = provider.agentCalls[0]
    expect(req).toMatchObject({ maxTurns: 20, model: 'sonnet', maxUsd: 2, mcp: { name: 'library' }, timeoutMs: 600000 })
    expect(req.input).toContain('Proposed, not in the form: regex_rules (1 paper: zhu2020loghub)')
    expect(req.input).toContain('RQ1: Which sanitization techniques preserve utility?')
    expect(await store.readCosts()).toEqual([expect.objectContaining({ paper_id: '', operation: 'suggest_facets', cost_usd: 0.4, model: 'claude-sonnet-5' })])
  })

  it('tells the agent what the user rejected, and drops it if it comes back', async () => {
    const { suggester, provider } = await setup([facetAgentResult()])
    const result = await suggester.suggest({ existing: [newValueSuggestion({ status: 'rejected' }), newFacetSuggestion({ status: 'accepted' })] })
    expect(result.suggestions.map((s) => s.kind)).toEqual(['new_facet', 'alias'])
    expect(result.dropped).toEqual(['rejected'])
    expect(provider.agentCalls[0].input).toContain('- new_value data_type: metrics')
    expect(provider.agentCalls[0].input).not.toContain('new_facet data_source')
  })

  it('refuses to run without a valid form, or over the monthly cap, before spending anything', async () => {
    const noForm = await setup([facetAgentResult()], { form: false })
    await expect(noForm.suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'invalid_form' })
    expect(noForm.provider.agentCalls).toHaveLength(0)

    const capped = await setup([facetAgentResult()])
    await capped.store.updateConfig({ llm: { ...capped.store.config.llm, budget: { ...capped.store.config.llm.budget, per_month_usd: 1 } } })
    await capped.store.appendCost(DEVICE, { at: NOW, paper_id: 'x', batch_id: null, model: 'm', cost_usd: 1, operation: 'summarize' })
    await expect(capped.suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(capped.provider.agentCalls).toHaveLength(0)
  })

  it('charges an invalid answer, and a cut-off run at its cap as an estimate', async () => {
    const { suggester, store } = await setup([facetAgentResult({ nothing: true }, 0.3), new LlmError('llm_timeout', 2, { estimated: true })])
    await expect(suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'llm_invalid_output' })
    await expect(suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'llm_timeout' })
    expect((await store.readCosts()).map((c) => [c.operation, c.cost_usd, c.estimated ?? false])).toEqual([
      ['suggest_facets', 0.3, false],
      ['suggest_facets', 2, true]
    ])
  })

  it('records a cancelled run at the per-run cap, marked as estimated, with its batch, without raising the estimate', async () => {
    const aborted = Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { costUsd: 2, estimated: true })
    const { suggester, store, budget } = await setup([aborted])
    await expect(suggester.suggest({ existing: [], batchId: 'b' })).rejects.toMatchObject({ name: 'AbortError' })
    expect((await store.readCosts()).map((c) => [c.cost_usd, c.estimated, c.operation, c.batch_id, c.paper_id])).toEqual([[2, true, 'suggest_facets', 'b', '']])
    expect(budget.currentEstimate('suggest_facets')).toBe(0.5)
  })

  it('reports agent_tools_unavailable before spending when the tool server cannot start', async () => {
    const { suggester, provider, budget, store } = await setup([facetAgentResult()], {
      startTools: async () => {
        throw new Error('EADDRINUSE')
      }
    })
    await expect(suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'agent_tools_unavailable' })
    expect(provider.agentCalls).toHaveLength(0)
    expect(budget.currentEstimate('suggest_facets')).toBe(0.5)
    expect(await store.readCosts()).toEqual([])
  })

  it('closes the tool server when the agent fails', async () => {
    const { suggester, servers } = await setup([new LlmError('llm_quota')])
    await expect(suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'llm_quota' })
    expect(servers).toHaveLength(1)
    await expect(fetch(servers[0].url, { method: 'POST' })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
  })

  it('learns its estimate from a real run', async () => {
    const { suggester, budget } = await setup([facetAgentResult(undefined, 1.2)])
    await suggester.suggest({ existing: [] })
    expect(budget.currentEstimate('suggest_facets')).toBe(1.2)
  })

  it('keeps the original error when the cost log cannot be written for a cut-off run', async () => {
    const { suggester, ledger, budget } = await setup([new LlmError('llm_timeout', 2, { estimated: true })])
    vi.spyOn(ledger, 'append').mockRejectedValue(new Error('disk full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(suggester.suggest({ existing: [] })).rejects.toMatchObject({ code: 'llm_timeout' })
    expect(budget.currentEstimate('suggest_facets')).toBe(0.5)
  })
})
