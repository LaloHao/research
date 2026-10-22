import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allowedHost, allowedOrigin, isLoopbackAddress, startLocalApiServer, type LocalApiServerHandle } from '../../../src/main/api/LocalApiServer'
import { costlyTool, freeTool, type ApiContext, type ApiTool } from '../../../src/main/api/registry'
import { WRITING_API_TOOLS } from '../../../src/main/api/writingTools'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { MapService } from '../../../src/main/map/MapService'
import { libraryTools } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { WritingService } from '../../../src/main/writing/WritingService'
import type { ApiOpenPaper } from '../../../src/shared/localApi'
import { DRAIN_ID, LOGHUB_ID, seedPair } from '../../helpers/pair'
import { tmpDir } from '../../helpers/tmp'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'

async function project() {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  cache.replaceTrash([{ id: 'old2010gone', title: 'Gone', authors_label: '', year: 2010, doi: null, openalex_id: null, trashed_at: null, device: null, problem: null }])
  const ledger = new CostLedger(store, 'test-device')
  const limits = () => limitsFromConfig(store.config.llm)
  const budget = new BudgetGuard(limits, () => ledger.monthTotal(), 0.05, { draft: 0.2 })
  const opened: ApiOpenPaper[] = []
  const ctx: ApiContext = {
    store,
    cache,
    library: libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }),
    writing: new WritingService({ store, cache, includedPapers: () => [] }),
    // No draft tool is called here (claudeTools.test.ts has them).
    drafts: {} as ApiContext['drafts'],
    capped: { budget, ledger, limits },
    openInApp: (r) => void opened.push(r)
  }
  return { store, cache, ctx, opened, ledger }
}

const servers: LocalApiServerHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(opts: { ctx: ApiContext | null; allowCostly?: boolean; tools?: ApiTool[] }): Promise<LocalApiServerHandle> {
  const server = await startLocalApiServer({ port: 0, token: () => TOKEN, context: () => opts.ctx, allowCostly: () => opts.allowCostly ?? false, tools: opts.tools })
  servers.push(server)
  return server
}

/** A raw HTTP request, so the Host and Origin headers are exactly what the test says. */
function raw(port: number, headers: Record<string, string>, body = '{}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

let rpcId = 0
/** A plain POST of a JSON-RPC `tools/call`, as the Emacs package sends it (no MCP session, no initialize). */
async function call(server: LocalApiServerHandle, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }
  if (json.error) return { isError: true, text: json.error.message }
  return { isError: json.result!.isError === true, text: json.result!.content.map((c) => c.text).join('') }
}
const ok = async (server: LocalApiServerHandle, name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const out = await call(server, name, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

describe('local API: access', () => {
  it('listens on 127.0.0.1 only and accepts only loopback peers, hosts and origins', async () => {
    const server = await serve({ ctx: null })
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'].every(isLoopbackAddress)).toBe(true)
    expect(['192.168.1.4', '10.0.0.1', '::ffff:10.0.0.1', '', undefined].some(isLoopbackAddress)).toBe(false)
    expect(allowedHost(`localhost:${server.port}`, server.port)).toBe(true)
    expect(allowedHost(`evil.example:${server.port}`, server.port)).toBe(false)
    expect(allowedHost(`127.0.0.1:${server.port + 1}`, server.port)).toBe(false)
    expect(allowedOrigin(undefined, server.port)).toBe(true)
    expect(allowedOrigin('https://evil.example', server.port)).toBe(false)
  })

  it('refuses a missing or wrong token, a foreign Host (DNS rebinding) and a foreign Origin', async () => {
    const server = await serve({ ctx: null })
    const host = `127.0.0.1:${server.port}`
    expect((await raw(server.port, { host })).status).toBe(401)
    expect((await raw(server.port, { host, authorization: 'Bearer nope' })).status).toBe(401)
    expect((await raw(server.port, { host, authorization: TOKEN })).status).toBe(401)
    expect((await raw(server.port, { host: `rebind.example:${server.port}`, authorization: `Bearer ${TOKEN}` })).status).toBe(403)
    expect((await raw(server.port, { host, origin: 'http://rebind.example', authorization: `Bearer ${TOKEN}` })).status).toBe(403)
    // Right token, host and a loopback origin: the request reaches MCP (which wants a JSON-RPC body).
    const reached = await raw(server.port, { host, origin: `http://localhost:${server.port}`, authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' })
    expect([401, 403]).not.toContain(reached.status)
  })

  it('answers no_project from every tool while no project is open', async () => {
    const server = await serve({ ctx: null })
    for (const [name, args] of [
      ['list_papers_for_citation', {}],
      ['search_text', { query: 'drain' }],
      ['open_in_app', { key: DRAIN_ID }]
    ] as const) {
      const out = await call(server, name, args)
      expect(out).toEqual({ isError: true, text: expect.stringMatching(/^no_project: /) })
    }
  })
})

describe('local API: tools', () => {
  it('offers the library tools and the writing tools', async () => {
    const { ctx } = await project()
    const server = await serve({ ctx })
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['search_text', 'read_pages', 'get_paper', ...WRITING_API_TOOLS.map((t) => t.name)]))
    expect(await ok(server, 'search_text', { query: 'fixed depth' })).toEqual([{ paper_id: DRAIN_ID, page: 1, text: expect.stringContaining('fixed depth') }])
  })

  it('lists the papers to cite and checks citations with code-point offsets', async () => {
    const { ctx } = await project()
    const server = await serve({ ctx })
    const papers = await ok(server, 'list_papers_for_citation')
    expect(papers.map((p: { key: string }) => p.key)).toEqual([DRAIN_ID, LOGHUB_ID])
    expect(papers[0]).toMatchObject({ key: DRAIN_ID, title: expect.any(String), year: 2017, has_text: true })

    const text = `😀 Logs [cite:@${DRAIN_ID}; @${DRAIN_ID}]. Gone [cite:@old2010gone] and [cite:@nobody2020x].`
    const report = await ok(server, 'check_citations_local', { text })
    expect(report.format).toBe('org')
    expect(report.unknown).toEqual(['nobody2020x'])
    expect(report.trashed).toEqual(['old2010gone'])
    expect(report.duplicates).toEqual([DRAIN_ID])
    const first = report.citations[0]
    // The emoji is two UTF-16 units but one character: offsets count characters.
    expect([...text].slice(first.start, first.end).join('')).toBe(`[cite:@${DRAIN_ID}; @${DRAIN_ID}]`)
    expect(report.citations[2].states).toEqual({ nobody2020x: 'unknown' })
  })

  it('builds the .bib of a text and of a file with its includes, confined to its folder', async () => {
    const { ctx } = await project()
    const server = await serve({ ctx })
    const fromText = await ok(server, 'bibtex_for_text', { text: `\\cite{${LOGHUB_ID},${DRAIN_ID}}`, order: 'alphabetical' })
    expect(fromText.bib.indexOf(`{${DRAIN_ID},`)).toBeLessThan(fromText.bib.indexOf(`{${LOGHUB_ID},`))
    expect(fromText.report.entries).toEqual([LOGHUB_ID, DRAIN_ID])

    const dir = await tmpDir()
    const outside = await tmpDir()
    await mkdir(join(dir, 'ch'))
    await writeFile(join(outside, 'secret.org'), `[cite:@${LOGHUB_ID}]`)
    await writeFile(join(dir, 'thesis.org'), `[cite:@${DRAIN_ID}]\n#+INCLUDE: "ch/one.org"\n#+INCLUDE: "${join(outside, 'secret.org')}"`)
    await writeFile(join(dir, 'ch/one.org'), '[cite:@nobody2020x]')
    const fromFile = await ok(server, 'bibtex_for_file', { path: join(dir, 'thesis.org') })
    expect(fromFile.report.keys).toEqual([DRAIN_ID, 'nobody2020x'])
    expect(fromFile.files.map((f: { path: string }) => f.path)).toEqual(['thesis.org', 'ch/one.org'])
    expect(fromFile.skipped).toEqual([expect.objectContaining({ reason: 'outside_folder' })])

    await symlink(join(dir, 'thesis.org'), join(dir, 'link.org'))
    expect((await call(server, 'bibtex_for_file', { path: 'thesis.org' })).text).toMatch(/^invalid_path: /)
    expect((await call(server, 'bibtex_for_file', { path: join(dir, 'link.org') })).text).toMatch(/^invalid_path: /)
    expect((await call(server, 'bibtex_for_file', { path: join(dir, 'ch') + '.org' })).text).toMatch(/^not_found: /)
    expect((await call(server, 'bibtex_for_file', { path: '/etc/passwd' })).text).toMatch(/^invalid_path: /)
  })

  it('renders the outline in the app’s words and checks the facet and the question', async () => {
    const { ctx, store, cache } = await project()
    await store.updateConfig({
      extraction_form: { facets: [{ key: 'task', type: 'single', description: 'Task', values: ['parsing', 'anomaly'] }], value_aliases: {} },
      thesis: { title: 'T', description: '', research_questions: [{ id: 'RQ1', text: 'How to parse logs?' }] }
    } as never)
    cache.setFacets(DRAIN_ID, [{ facet: 'task', value: 'parsing', reviewed: true }], null)
    const server = await serve({ ctx })
    const out = await ok(server, 'outline', { rq: 'RQ1', format: 'latex' })
    expect(out.facet).toBe('task')
    expect(out.text).toContain('\\section{parsing}')
    expect(out.text).toContain('% HUECO: anomaly: sin papers')
    expect(out.text).toContain('pregunta RQ1: How to parse logs?')
    expect(out.gaps.values).toEqual(['anomaly'])
    expect((await call(server, 'outline', { facet: 'venue' })).text).toMatch(/^not_found: /)
    expect((await call(server, 'outline', { rq: 'RQ9' })).text).toMatch(/^not_found: /)
  })

  it('finds passages with the best sentence and opens a paper in the app', async () => {
    const { ctx, opened } = await project()
    const server = await serve({ ctx })
    const hits = await ok(server, 'find_passages', { query: 'sixteen datasets', keys: [LOGHUB_ID] })
    expect(hits).toEqual([{ key: LOGHUB_ID, title: expect.stringContaining('Loghub'), page: 2, text: expect.any(String), quote: expect.stringContaining('sixteen Loghub datasets') }])
    expect(await ok(server, 'open_in_app', { key: DRAIN_ID, page: 2, quote: ' highest accuracy ' })).toEqual({ opened: true })
    expect(opened).toEqual([{ paper: DRAIN_ID, page: 2, quote: 'highest accuracy' }])
    expect((await call(server, 'open_in_app', { key: 'nobody2020x' })).text).toMatch(/^not_found: /)
    expect(opened).toHaveLength(1)
  })
})

describe('local API: costly tools', () => {
  const runs: (number | null)[] = []
  const fake = costlyTool({
    name: 'fake_draft',
    description: 'A fake costly tool',
    input: { title: z.string() },
    cost: { kind: 'draft', model: () => 'claude-sonnet-5', plan: async (_ctx, args) => ({ title: args.title, papers: 3 }) },
    async run(_ctx, args, maxUsd) {
      runs.push(maxUsd)
      return { costUsd: 0.12, model: 'claude-sonnet-5', text: `Draft of ${args.title}` }
    }
  })

  it('is refused while Settings does not allow costly operations', async () => {
    const { ctx } = await project()
    const server = await serve({ ctx, tools: [fake] })
    runs.length = 0
    expect((await call(server, 'fake_draft', { title: 'Intro', confirmed: true })).text).toMatch(/^costly_disabled: /)
    expect(runs).toEqual([])
  })

  it('answers its plan without confirmed, and runs capped and charged with it', async () => {
    const { ctx, ledger, store } = await project()
    const server = await serve({ ctx, allowCostly: true, tools: [fake] })
    runs.length = 0
    const plan = await ok(server, 'fake_draft', { title: 'Intro' })
    expect(plan).toEqual({
      confirmation_required: true,
      operation: 'draft',
      model: 'claude-sonnet-5',
      estimate_usd: 0.2,
      cap_usd: store.config.llm.budget.per_draft_usd,
      month_spent_usd: 0,
      month_cap_usd: null,
      title: 'Intro',
      papers: 3
    })
    expect(await ok(server, 'fake_draft', { title: 'Intro', confirmed: false })).toMatchObject({ confirmation_required: true })
    expect(runs).toEqual([])
    expect(await ok(server, 'fake_draft', { title: 'Intro', confirmed: true })).toEqual({ costUsd: 0.12, model: 'claude-sonnet-5', text: 'Draft of Intro' })
    expect(runs).toEqual([store.config.llm.budget.per_draft_usd])
    expect(await ledger.monthTotal()).toBeCloseTo(0.12)
  })

  it('is refused over the monthly cap', async () => {
    const { ctx, store, ledger } = await project()
    await store.updateConfig({ llm: { ...store.config.llm, budget: { ...store.config.llm.budget, per_month_usd: 0.5 } } })
    await ledger.append({ paperId: '', model: 'claude-sonnet-5', costUsd: 0.5, operation: 'chat' })
    const server = await serve({ ctx, allowCostly: true, tools: [fake] })
    runs.length = 0
    expect((await call(server, 'fake_draft', { title: 'Intro', confirmed: true })).text).toMatch(/^budget_exceeded: /)
    expect(runs).toEqual([])
  })
})

describe('local API: closing', () => {
  it('stops listening at once and waits for the calls in progress, at most its grace period', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const slow = freeTool({
      name: 'slow',
      description: 'Answers when released',
      input: {},
      async run() {
        await held
        return { done: true }
      }
    })
    const never = freeTool({ name: 'never', description: 'Never answers', input: {}, run: () => new Promise(() => undefined) })
    const { ctx } = await project()
    const server = await startLocalApiServer({ port: 0, token: () => TOKEN, context: () => ctx, allowCostly: () => false, tools: [slow, never] })
    const pending = call(server, 'slow')
    await new Promise((r) => setTimeout(r, 50))
    let closed = false
    const closing = server.close(5_000).then(() => (closed = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(closed).toBe(false)
    await expect(fetch(server.url, { method: 'POST' })).rejects.toThrow()
    release()
    expect(JSON.parse((await pending).text)).toEqual({ done: true })
    await closing

    const other = await startLocalApiServer({ port: 0, token: () => TOKEN, context: () => ctx, allowCostly: () => false, tools: [slow, never] })
    const lost = call(other, 'never').catch(() => 'hung up')
    await new Promise((r) => setTimeout(r, 50))
    const started = Date.now()
    await other.close(100)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await lost).toBe('hung up')
  })
})
