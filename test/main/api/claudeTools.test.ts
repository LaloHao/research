import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startLocalApiServer, type LocalApiServerHandle } from '../../../src/main/api/LocalApiServer'
import type { ApiContext } from '../../../src/main/api/registry'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { LlmError, type CompleteRequest, type CompleteResult } from '../../../src/main/llm/LlmProvider'
import { MapService } from '../../../src/main/map/MapService'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { CiteChecker } from '../../../src/main/writing/CiteChecker'
import { DraftService } from '../../../src/main/writing/DraftService'
import { startLibraryMcpServer } from '../../../src/main/mcp/LibraryMcpServer'
import { scopeLibraryTools } from '../../../src/main/mcp/scopedTools'
import { WritingService } from '../../../src/main/writing/WritingService'
import { chatAnswer, FakeLlmProvider, type ChatResponse } from '../../helpers/llm'
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

async function project(responses: Respond[], chats: ChatResponse[] = []) {
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
  const provider = new FakeLlmProvider(responses, [], chats)
  const map = new MapService({ store, cache })
  const drafts = new DraftService({
    store,
    cache,
    provider,
    budget,
    ledger,
    machine: 'laptop',
    startTools: (o, papers) => startLibraryMcpServer(scopeLibraryTools(libraryTools({ store, cache, map, embeddings: null }), papers), o),
    emit: () => undefined,
    stream: () => undefined
  })
  const checker = new CiteChecker({ store, cache, provider, budget, ledger, limits, embedder: async () => null })
  const ctx: ApiContext = {
    store,
    cache,
    library: libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }),
    writing: new WritingService({ store, cache, includedPapers: () => [], llm: { provider, budget, ledger }, checker }),
    drafts,
    capped: { budget, ledger, limits },
    openInApp: () => undefined
  }
  return { store, provider, ledger, ctx, drafts }
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

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(done()).toBe(true)
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

  it('draft: answers at once with its id; draft_status follows it to its text converted, charged once', async () => {
    const text = `Online parsers exist [[${DRAIN_ID}|p. 1|"Drain parses log messages online"]]. Everyone agrees [[sin cita]]. Loghub too [[${LOGHUB_ID}|p. 1|"Loghub is a large collection of system log datasets"]].`
    const { store, provider, ctx, drafts } = await project([], [chatAnswer(text, 0.12)])
    const server = await serve(ctx)
    const args = { title: 'Log parsing', purpose: 'Compare online parsers.', keys: [DRAIN_ID], length: 'short' }
    expect(await ok(server, 'draft', args)).toMatchObject({ confirmation_required: true, operation: 'draft', papers: 1, length: 'short', running_draft: null })
    expect(provider.chatCalls).toHaveLength(0)

    const started = await ok(server, 'draft', { ...args, confirmed: true })
    expect(started).toMatchObject({ status: 'running', costUsd: 0 })
    await drafts.idle()
    const out = await ok(server, 'draft_status', { draft_id: started.draft_id, format: 'latex' })
    expect(out).toMatchObject({ status: 'done', title: 'Log parsing', format: 'latex', unverified: 0, outside: 1, uncited: 1, costUsd: 0.12 })
    expect(out.text).toContain(`\\cite[p.~1]{${DRAIN_ID}}`)
    expect(out.text).toContain('[SIN CITA]')
    expect(drafts.list().map((d) => d.id)).toEqual([started.draft_id])
    expect(await costs(store)).toEqual([['draft', 0.12]])
  })

  it('draft: one at a time from the API; draft_stop keeps what arrived and a new one may start then', async () => {
    let release!: () => void
    const waiting = new Promise<void>((r) => (release = r))
    const slow: ChatResponse = async (req, emit) => {
      emit({ kind: 'turn' })
      emit({ kind: 'delta', text: 'Parsers parse.' })
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))
      release()
      return chatAnswer('never')
    }
    const { store, provider, ctx, drafts } = await project([], [slow, chatAnswer('Second.', 0.05)])
    const server = await serve(ctx)
    const args = { title: 'T', keys: [DRAIN_ID] }
    const first = await ok(server, 'draft', { ...args, confirmed: true })
    await until(() => drafts.progress(first.draft_id)?.chars === 14)
    expect(await ok(server, 'draft_status', { draft_id: first.draft_id })).toMatchObject({ status: 'running', chars: 14 })
    expect(await ok(server, 'draft', args)).toMatchObject({ confirmation_required: true, running_draft: first.draft_id })
    // A retry while it runs never starts a second paid draft.
    const again = await call(server, 'draft', { ...args, confirmed: true })
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/^busy: /)
    expect(provider.chatCalls).toHaveLength(1)

    expect(await ok(server, 'draft_stop', { draft_id: first.draft_id })).toEqual({ draft_id: first.draft_id, stopping: true })
    await waiting
    await drafts.idle()
    expect(await ok(server, 'draft_status', { draft_id: first.draft_id })).toMatchObject({ status: 'stopped', text: 'Parsers parse.' })
    expect(await ok(server, 'draft_stop', { draft_id: first.draft_id })).toMatchObject({ stopping: false })

    const second = await ok(server, 'draft', { ...args, confirmed: true })
    await drafts.idle()
    expect(await ok(server, 'draft_status', { draft_id: second.draft_id })).toMatchObject({ status: 'done', text: 'Second.' })
    expect((await costs(store)).map(([op]) => op)).toEqual(['draft', 'draft'])
  })

  it('draft_status: a run that fails right after it started reports its real error code', async () => {
    const { ctx, drafts } = await project([], [new LlmError('llm_quota', 0)])
    const server = await serve(ctx)
    const started = await ok(server, 'draft', { title: 'T', keys: [DRAIN_ID], confirmed: true })
    await drafts.idle()
    expect(await ok(server, 'draft_status', { draft_id: started.draft_id })).toEqual({ draft_id: started.draft_id, status: 'error', error: 'llm_quota' })
    expect((await call(server, 'draft_status', { draft_id: '20260101-000000-abcd' })).text).toMatch(/^not_found: /)
  })

  it('a check whose caller hangs up stops, and the project close stops and awaits an API run', async () => {
    let calls = 0
    const waitAbort = (req: CompleteRequest): Promise<CompleteResult> =>
      new Promise((_resolve, reject) => {
        calls++
        req.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
      })
    const { ctx, provider } = await project([])
    provider.complete = waitAbort
    const writing = ctx.writing as WritingService
    const server = await serve(ctx)
    const hangUp = new AbortController()
    const request = fetch(server.url, {
      method: 'POST',
      signal: hangUp.signal,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'style', arguments: { text: 'It parse logs.', confirmed: true } } })
    }).catch(() => null)
    await until(() => writing.runningCount === 1)
    hangUp.abort()
    await request
    await until(() => writing.runningCount === 0)

    const pending = call(server, 'style', { text: 'It parse logs.', confirmed: true })
    await until(() => writing.runningCount === 1)
    await writing.close()
    expect(writing.runningCount).toBe(0)
    expect((await pending).isError).toBe(true)
    expect(calls).toBe(2)
    // Closed: no new run starts.
    expect((await call(server, 'style', { text: 'It parse logs.', confirmed: true })).text).toMatch(/^llm_unavailable: /)
  })

  it('stays refused while Settings does not allow costly operations', async () => {
    const { provider, ctx } = await project([echo('supports')])
    const server = await serve(ctx, false)
    expect((await call(server, 'style', { text: 'It parse logs.', confirmed: true })).text).toMatch(/^costly_disabled: /)
    expect((await call(server, 'cite_check', { text: `x \\cite{${DRAIN_ID}}.` })).text).toMatch(/^costly_disabled: /)
    expect(provider.calls).toHaveLength(0)
  })
})
