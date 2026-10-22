import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startLocalApiServer, type LocalApiServerHandle } from '../../../src/main/api/LocalApiServer'
import type { ApiContext } from '../../../src/main/api/registry'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import type { CompleteRequest, CompleteResult } from '../../../src/main/llm/LlmProvider'
import { MapService } from '../../../src/main/map/MapService'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { CiteChecker } from '../../../src/main/writing/CiteChecker'
import { WritingService } from '../../../src/main/writing/WritingService'
import { FakeLlmProvider } from '../../helpers/llm'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { sampleThesis } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
const DRAIN_QUOTE = 'Drain reaches the highest accuracy on five datasets'
type Respond = CompleteResult | Error | ((req: CompleteRequest) => CompleteResult | Error)

/** Every (sentence, paper) the citation check asked about gets `verdict`, quoting Drain's second page. */
function echo(verdict: string, costUsd = 0.05): (req: CompleteRequest) => CompleteResult {
  return (req) => ({
    value: {
      results: [...req.input.matchAll(/<record id="(\d+)">([\s\S]*?)<\/record>/g)].flatMap((m) =>
        [...m[2].matchAll(/<paper id="([a-z0-9]+)">/g)].map((p) => ({ sentence: Number(m[1]), paper: p[1], verdict, quote: DRAIN_QUOTE, page: 2, note: 'Matches.' }))
      )
    },
    costUsd,
    model: 'claude-sonnet-5'
  })
}

async function project(responses: Respond[]) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  await store.updateConfig({
    thesis: sampleThesis,
    extraction_form: { facets: [{ key: 'task', type: 'single', description: 'Task', values: ['parsing', 'anomaly'] }], value_aliases: {} }
  })
  cache.setFacets(DRAIN_ID, [{ facet: 'task', value: 'parsing', reviewed: true }], null)
  cache.setFacets(LOGHUB_ID, [{ facet: 'task', value: 'anomaly', reviewed: true }], null)
  const ledger = new CostLedger(store, 'test-device')
  const limits = () => limitsFromConfig(store.config.llm)
  const budget = new BudgetGuard(limits, () => ledger.monthTotal(), 0.05, { cite_check: 0.2, outline: 0.1, style: 0.1 })
  const provider = new FakeLlmProvider(responses)
  const checker = new CiteChecker({ store, cache, provider, budget, ledger, limits, embedder: async () => null })
  const ctx: ApiContext = {
    store,
    cache,
    library: libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }),
    writing: new WritingService({ store, cache, includedPapers: () => [], llm: { provider, budget, ledger }, checker }),
    capped: { budget, ledger, limits },
    openInApp: () => undefined
  }
  return { store, provider, ledger, ctx }
}

const servers: LocalApiServerHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(ctx: ApiContext, allowCostly = true): Promise<LocalApiServerHandle> {
  const server = await startLocalApiServer({ port: 0, token: () => TOKEN, context: () => ctx, allowCostly: () => allowCostly })
  servers.push(server)
  return server
}

async function call(server: LocalApiServerHandle, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { isError: json.result.isError === true, text: json.result.content.map((c) => c.text).join('') }
}
const ok = async (server: LocalApiServerHandle, name: string, args: Record<string, unknown>): Promise<any> => {
  const out = await call(server, name, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

const costs = async (store: ProjectStore) => (await store.readCosts()).map((c) => [c.operation, c.cost_usd])

describe('local API: costly tools of «Redacción»', () => {
  it('cite_check: a text-dependent plan, then the verdicts at character offsets, charged once', async () => {
    const { store, provider, ctx } = await project([echo('supports', 0.07)])
    const server = await serve(ctx)
    const text = `😀 Drain is the most accurate parser \\cite{${DRAIN_ID}}.`
    const plan = await ok(server, 'cite_check', { text })
    expect(plan).toMatchObject({ confirmation_required: true, operation: 'cite_check', sentences: 1, pairs: 1, batches: 1, estimate_usd: 0.2 })
    expect(provider.calls).toHaveLength(0)

    const out = await ok(server, 'cite_check', { text, confirmed: true })
    expect(out.format).toBe('latex')
    expect(out.counts.supports).toBe(1)
    const [sentence] = out.sentences
    expect([...text].slice(sentence.citations[0].start, sentence.citations[0].end).join('')).toBe(`\\cite{${DRAIN_ID}}`)
    expect(sentence.entries).toEqual([
      { key: DRAIN_ID, outcome: 'supports', verdict: 'supports', reason: null, quote: DRAIN_QUOTE, page: 2, found: true, note: 'Matches.' }
    ])
    expect(provider.calls).toHaveLength(1)
    // Charged once by the service (the registry does not wrap it again).
    expect(await costs(store)).toEqual([['cite_check', 0.07]])
    expect(out.costUsd).toBe(0.07)
  })

  it('outline_proposal: the rendered proposal with its unverified citations, charged once; a wrong facet costs nothing', async () => {
    const proposal = {
      order: ['S1', 'S2'],
      sections: [
        { id: 'S1', title: 'Parsing logs', opening: `Drain parses online [[${DRAIN_ID}|p. 1|"Drain parses log messages online"]].` },
        { id: 'S2', title: 'Detecting anomalies', opening: `Loghub is large [[${LOGHUB_ID}|p. 2|"an invented sentence that is nowhere"]].` }
      ],
      gaps: []
    }
    const { store, provider, ctx } = await project([{ value: proposal, costUsd: 0.03, model: 'claude-sonnet-5' }])
    const server = await serve(ctx)
    expect((await call(server, 'outline_proposal', { facet: 'venue', confirmed: true })).text).toMatch(/^not_found: /)
    expect(provider.calls).toHaveLength(0)

    expect(await ok(server, 'outline_proposal', { rq: 'RQ1' })).toMatchObject({ confirmation_required: true, operation: 'outline', estimate_usd: 0.1 })
    const out = await ok(server, 'outline_proposal', { rq: 'RQ1', format: 'latex', confirmed: true })
    expect(out.text).toContain('\\section{Parsing logs}')
    expect(out.text).toContain(`\\cite[p.~1]{${DRAIN_ID}}`)
    expect(out.unverified).toBe(1)
    expect(await costs(store)).toEqual([['outline', 0.03]])
  })

  it('style: suggestions at character offsets and the dropped counts, charged once', async () => {
    const text = '😀 Drain are fast. It parse logs \\cite{he2017drain}.'
    const suggestions = [
      { original: 'Drain are fast', suggestion: 'Drain is fast', reason: 'Agreement.', category: 'grammar', context: null },
      { original: '\\cite{he2017drain}', suggestion: '\\citep{he2017drain}', reason: 'Style.', category: 'grammar', context: null }
    ]
    const { store, ctx } = await project([{ value: { suggestions }, costUsd: 0.02, model: 'claude-sonnet-5' }])
    const server = await serve(ctx)
    const out = await ok(server, 'style', { text, focus: ['grammar'], confirmed: true })
    expect(out.suggestions).toEqual([{ id: 0, start: 2, end: 16, original: 'Drain are fast', suggestion: 'Drain is fast', reason: 'Agreement.', category: 'grammar' }])
    expect([...text].slice(2, 16).join('')).toBe('Drain are fast')
    expect(out.dropped.protected).toBe(1)
    expect(await costs(store)).toEqual([['style', 0.02]])
  })

  it('stays refused while Settings does not allow costly operations', async () => {
    const { provider, ctx } = await project([echo('supports')])
    const server = await serve(ctx, false)
    expect((await call(server, 'style', { text: 'It parse logs.', confirmed: true })).text).toMatch(/^costly_disabled: /)
    expect((await call(server, 'cite_check', { text: `x \\cite{${DRAIN_ID}}.` })).text).toMatch(/^costly_disabled: /)
    expect(provider.calls).toHaveLength(0)
  })
})
