import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { LlmError, type AgentRequest } from '../../../src/main/llm/LlmProvider'
import { MapService } from '../../../src/main/map/MapService'
import { startLibraryMcpServer, type LibraryMcpHandle, type LibraryMcpOptions } from '../../../src/main/mcp/LibraryMcpServer'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { RelationSuggester } from '../../../src/main/relations/RelationSuggester'
import { FakeLlmProvider, type AgentResponse } from '../../helpers/llm'
import { callTools } from '../../helpers/mcp'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES, seedPair } from '../../helpers/pair'
import { samplePaper } from '../../helpers/papers'
import { agentResult, LOGHUB_EXTENDS_DRAIN, NOW, typedRelation } from '../../helpers/relations'
import { tmpDir } from '../../helpers/tmp'

async function setup(agent: AgentResponse[], startTools?: (opts: LibraryMcpOptions) => Promise<LibraryMcpHandle>) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const provider = new FakeLlmProvider([], agent)
  const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date(NOW))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal(), 0.05, { suggest_relations: 0.25 })
  const map = new MapService({ store, cache })
  const servers: LibraryMcpHandle[] = []
  const start =
    startTools ??
    (async (opts: LibraryMcpOptions) => {
      const server = await startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: null }), opts)
      servers.push(server)
      return server
    })
  const suggester = new RelationSuggester({ store, cache, provider, budget, ledger, startTools: start, now: () => new Date(NOW) })
  return { store, cache, provider, budget, suggester, servers }
}

describe('RelationSuggester', () => {
  it('lets the agent read the library through MCP and returns checked suggestions', async () => {
    const { suggester, provider, store } = await setup([
      async (req: AgentRequest) => {
        const [page] = await callTools(req.mcp, [{ name: 'read_pages', arguments: { paper_id: LOGHUB_ID, from: 2, to: 2 } }])
        expect(page.text).toContain('sixteen')
        return agentResult()
      }
    ])
    const result = await suggester.suggest({ paperId: LOGHUB_ID, existing: [] })
    expect(result.relations).toEqual([
      {
        id: 'he2017drain__zhu2020loghub__extends',
        type: 'extends',
        from: LOGHUB_ID,
        to: DRAIN_ID,
        status: 'suggested',
        edited: false,
        justification: 'Loghub extends the Drain parser.',
        evidence: [
          { paper: LOGHUB_ID, page: 2, quote: LOGHUB_PAGES[1], found: true },
          { paper: DRAIN_ID, page: 1, quote: DRAIN_PAGES[0], found: true }
        ],
        origin: { model: 'claude-sonnet-5', at: NOW, prompt_version: 1, paper: LOGHUB_ID },
        updated_at: NOW
      }
    ])
    expect(result).toMatchObject({ costUsd: 0.12, toolCalls: 1, evidenceFound: 2, evidenceTotal: 2, dropped: [], candidates: [{ id: DRAIN_ID, via: ['cites'] }] })
    const req = provider.agentCalls[0]
    expect(req).toMatchObject({ maxTurns: 12, model: 'sonnet', maxUsd: 0.5, mcp: { name: 'library' }, timeoutMs: 600000 })
    expect(req.input).toContain(`id: ${DRAIN_ID}`)
    expect(req.system).toContain('uses_method_of')
    expect(await store.readCosts()).toEqual([expect.objectContaining({ paper_id: LOGHUB_ID, operation: 'suggest_relations', cost_usd: 0.12, model: 'claude-sonnet-5' })])
  })

  it('marks quotes it cannot find and corrects their page', async () => {
    const relation = {
      ...LOGHUB_EXTENDS_DRAIN,
      evidence: [
        { paper: LOGHUB_ID, page: 1, quote: LOGHUB_PAGES[1] },
        { paper: DRAIN_ID, page: 1, quote: 'an invented sentence about prefix trees' }
      ]
    }
    const { suggester } = await setup([agentResult([relation])])
    const result = await suggester.suggest({ paperId: LOGHUB_ID, existing: [] })
    expect(result.relations[0].evidence.map((e) => [e.page, e.found])).toEqual([
      [2, true],
      [1, false]
    ])
    expect(result).toMatchObject({ evidenceFound: 1, evidenceTotal: 2 })
  })

  it('tells the agent about existing relations and drops rejected ones and pairs outside the candidates', async () => {
    const rejected = typedRelation({ status: 'rejected' })
    const { suggester, provider } = await setup([
      agentResult([LOGHUB_EXTENDS_DRAIN, { ...LOGHUB_EXTENDS_DRAIN, to: 'other2020x' }, { ...LOGHUB_EXTENDS_DRAIN, type: 'uses_method_of' }])
    ])
    const result = await suggester.suggest({ paperId: LOGHUB_ID, existing: [rejected] })
    expect(result.relations.map((r) => r.type)).toEqual(['uses_method_of'])
    expect(result.dropped).toEqual(['rejected', 'not_a_candidate'])
    expect(provider.agentCalls[0].input).toContain('- zhu2020loghub extends he2017drain (rejected)')
  })

  it('leaves out the candidates in skip (pairs already analyzed from the other side)', async () => {
    const { suggester, provider } = await setup([agentResult()])
    const result = await suggester.suggest({ paperId: LOGHUB_ID, existing: [], skip: new Set([DRAIN_ID]) })
    expect(result).toMatchObject({ relations: [], candidates: [], costUsd: 0 })
    expect(provider.agentCalls).toHaveLength(0)
  })

  it('spends nothing when the paper has no candidates', async () => {
    const { suggester, provider, store, cache } = await setup([agentResult()])
    const solo = samplePaper({ id: 'am2019solo', title: 'Solo', identifiers: {} })
    await store.writePaper(solo, null)
    cache.upsertPaper(solo, 'h', false)
    cache.setText('am2019solo', 't', 'ok', [{ index: 0, page: 1, text: 'Alone.' }])
    const result = await suggester.suggest({ paperId: 'am2019solo', existing: [] })
    expect(result).toMatchObject({ relations: [], candidates: [], costUsd: 0 })
    expect(provider.agentCalls).toHaveLength(0)
  })

  it('fails with llm_invalid_output, cost logged, when the answer has no relations list', async () => {
    const { suggester, store } = await setup([{ value: { nope: true }, costUsd: 0.2, model: 'claude-sonnet-5' }])
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [] })).rejects.toMatchObject({ code: 'llm_invalid_output', costUsd: 0.2 })
    expect((await store.readCosts()).map((c) => c.cost_usd)).toEqual([0.2])
  })

  it('records a timed-out or cancelled run at the per-operation cap, marked as estimated, without raising the estimate', async () => {
    const aborted = Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { costUsd: 0.5, estimated: true })
    const { suggester, store, budget } = await setup([new LlmError('llm_timeout', 0.5, { estimated: true }), aborted])
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [], batchId: 'b' })).rejects.toMatchObject({ code: 'llm_timeout' })
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [], batchId: 'b' })).rejects.toMatchObject({ name: 'AbortError' })
    expect((await store.readCosts()).map((c) => [c.cost_usd, c.estimated, c.operation, c.batch_id])).toEqual([
      [0.5, true, 'suggest_relations', 'b'],
      [0.5, true, 'suggest_relations', 'b']
    ])
    expect(budget.currentEstimate('suggest_relations')).toBe(0.25)
  })

  it('reports agent_tools_unavailable before spending when the tool server cannot start', async () => {
    const { suggester, provider, budget } = await setup([agentResult()], async () => {
      throw new Error('EADDRINUSE')
    })
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [] })).rejects.toMatchObject({ code: 'agent_tools_unavailable' })
    expect(provider.agentCalls).toHaveLength(0)
    expect(budget.currentEstimate('suggest_relations')).toBe(0.25)
  })

  it('closes the tool server when the agent fails', async () => {
    const { suggester, servers } = await setup([new LlmError('llm_quota')])
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [] })).rejects.toMatchObject({ code: 'llm_quota' })
    await expect(fetch(servers[0].url, { method: 'POST' })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
  })

  it('needs the paper text indexed', async () => {
    const { suggester, cache } = await setup([agentResult()])
    cache.setText(LOGHUB_ID, null, 'no_source', [])
    await expect(suggester.suggest({ paperId: LOGHUB_ID, existing: [] })).rejects.toMatchObject({ code: 'no_text' })
  })
})
