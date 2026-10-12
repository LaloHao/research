import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LlmError, type CompleteRequest } from '../../../src/main/llm/LlmProvider'
import { OpenAlexSearch } from '../../../src/main/mapping/OpenAlexSearch'
import type { JobSpec } from '../../../src/shared/jobs'
import type { ProtocolDraft } from '../../../src/shared/mapping'
import { DRAIN } from '../../helpers/library'
import { FakeLlmProvider } from '../../helpers/llm'
import { candidate, setupMappings } from '../../helpers/mappings'
import { samplePaper } from '../../helpers/papers'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const SEARCH_ROUTES = [
  { url: /\/works\?search=.*cursor=\*/, body: fx('mapping.search-1.openalex.json') },
  { url: /\/works\?search=.*cursor=IlsxMDAu/, body: fx('mapping.search-2.openalex.json') },
  { url: /filter=ids\.openalex/, body: fx('mapping.works.openalex.json') }
]
const signal = new AbortController().signal
const draft: ProtocolDraft = {
  title: 'Logs',
  objective: '',
  research_questions: [],
  inclusion: [{ id: null, text: 'Processes software logs.' }],
  exclusion: [{ id: null, text: 'Not about software logs.' }],
  years: { from: null, to: null },
  publication_types: []
}
const as = <T extends JobSpec['type']>(spec: JobSpec, type: T): Extract<JobSpec, { type: T }> => {
  if (spec.type !== type) throw new Error(`expected ${type}, got ${spec.type}`)
  return spec as Extract<JobSpec, { type: T }>
}

describe('OpenAlex searches', () => {
  it('fetch every page up to the cap and log the exact string, filters, request and counts', async () => {
    const { service, queued } = await setupMappings({ routes: SEARCH_ROUTES })
    const id = await service.create('Logs')
    service.requestSearch(id, { query: '  log anonymization ', fromYear: 2015, toYear: null, types: ['article', 'article'], cap: 500 })
    const spec = as(queued[0], 'mapping_search')
    expect(spec).toEqual({ type: 'mapping_search', mappingId: id, query: 'log anonymization', fromYear: 2015, toYear: null, types: ['article'], cap: 500 })
    expect(await service.runSearch(spec, signal)).toEqual({ message: 'mapping_searched' })
    const view = await service.open(id)
    expect(view.searches[0]).toMatchObject({
      kind: 'openalex',
      database: 'OpenAlex',
      query: 'log anonymization',
      filters: { publication_year: '>2014', type: 'article' },
      request: 'https://api.openalex.org/works?search=log+anonymization&filter=publication_year%3A%3E2014%2Ctype%3Aarticle',
      count: 3,
      total: 3,
      capped: false
    })
    expect(view.prisma.databases.screened).toBe(3)
  })

  it('stop at the cap and say there were more', async () => {
    const { service, queued, fetch } = await setupMappings({ routes: SEARCH_ROUTES })
    const id = await service.create('Logs')
    service.requestSearch(id, { query: 'logs', fromYear: null, toYear: null, types: [], cap: 2 })
    await service.runSearch(as(queued[0], 'mapping_search'), signal)
    expect((await service.open(id)).searches[0]).toMatchObject({ count: 2, total: 3, capped: true, filters: {} })
    expect(fetch.calls).toHaveLength(1)
    expect(() => service.requestSearch(id, { query: ' ', fromYear: null, toYear: null, types: [], cap: 10 })).toThrow('invalid_edit')
    expect(() => service.requestSearch('20261012-100000-ffff', { query: 'x', fromYear: null, toYear: null, types: [], cap: 10 })).toThrow('mapping_not_found')
  })
})

describe('snowballing', () => {
  it('starts from the included library papers, both ways, and logs its iteration and origin', async () => {
    const { service, queued, store, library, cache, citationCalls } = await setupMappings({ routes: SEARCH_ROUTES })
    const citations = { source: 'openalex' as const, fetched_at: '2026-10-01T00:00:00.000Z', openalex_id: 'W2754665629', references: ['W3000000003'] }
    await store.writePaper(samplePaper({ citations }), null)
    await library.indexPaper('he2017drain')
    cache.setIncoming('he2017drain', ['W3000000003', 'W3000000099'], '2026-10-02T00:00:00.000Z')
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    expect(() => service.requestSnowball(id, 'both')).toThrow('nothing_to_snowball')
    await service.addFromLibrary(id, ['he2017drain'])
    const [row] = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    await service.decide(id, { recordId: row.id, phase: 'full_text', decision: 'include', criterion: null, suggestionId: null })
    service.requestSnowball(id, 'both')
    expect(await service.runSnowball(as(queued[0], 'mapping_snowball'), signal)).toEqual({ message: 'snowballed' })
    expect(citationCalls).toEqual(['cited_by:he2017drain'])
    const view = await service.open(id)
    expect(view.searches[0]).toMatchObject({ kind: 'snowball', database: 'OpenAlex', filters: { direction: 'both' }, origin: { direction: 'both', from: [row.id], iteration: 1 }, total: 2, count: 1 })
    expect(view.prisma.other).toMatchObject({ screened: 2, duplicates: 0, identified: [{ kind: 'library', count: 1 }, { kind: 'snowball', count: 1 }] })
  })
})

describe('adding included records to the library', () => {
  it('plans, queues and ingests them with the usual ingest, falling back to the record when the identifier is unknown', async () => {
    const { service, queued, store } = await setupMappings({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [
      candidate(),
      candidate({ title: 'Masking secrets in system logs before sharing them', year: 2023, identifiers: { doi: '10.5555/mask.2023' } })
    ])
    for (const row of service.queue(id, { phase: 'title_abstract', filter: 'pending' })) {
      await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    }
    expect(service.ingestPlan(id)).toEqual({ count: 2, autoSummarize: false, estimateUsd: 0 })
    await store.updateConfig({ llm: { ...store.config.llm, auto_summarize: true } })
    expect(service.ingestPlan(id)).toEqual({ count: 2, autoSummarize: true, estimateUsd: 0.1 })
    expect(service.requestIngest(id)).toBe(2)
    const specs = queued.map((s) => as(s, 'ingest_record'))
    expect(new Set(specs.map((s) => s.batchId)).size).toBe(1)
    const outcomes = []
    for (const spec of specs) outcomes.push(await service.ingestRecord(spec, signal))
    expect(outcomes.map((o) => o.status)).toEqual(['added', 'added'])
    expect(outcomes.map((o) => o.paperId).sort()).toEqual(['he2017drain', 'he2023masking'])
    expect(service.queue(id, { phase: 'full_text', filter: 'pending' }).map((r) => r.paper_id).sort()).toEqual(['he2017drain', 'he2023masking'])
    expect(service.ingestPlan(id).count).toBe(0)
    expect(await service.ingestRecord(specs[0], signal)).toMatchObject({ status: 'duplicate' })
  })
})

describe("Claude's suggestions", () => {
  const byInput = (req: CompleteRequest) => ({
    value: {
      suggestions: [...req.input.matchAll(/<record id="(r[0-9a-f]{12})">/g)].map((m) => ({ record: m[1], decision: 'uncertain', criterion: null, justification: 'Falta información.', quote: null }))
    },
    costUsd: 0.02,
    model: 'claude-sonnet-5'
  })

  it('plans the batch with its costs and caps, and queues one call per 20 undecided records', async () => {
    const { service, queued } = await setupMappings()
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addSearch(
      id,
      { kind: 'openalex', database: 'OpenAlex', query: 'q' },
      Array.from({ length: 45 }, (_, i) => candidate({ title: `Study number ${i} on the anonymization of logs`, identifiers: { doi: `10.5555/study.${i}` } }))
    )
    expect(await service.suggestPlan(id, 'title_abstract')).toEqual({
      phase: 'title_abstract',
      count: 45,
      calls: 3,
      estimateUsd: expect.closeTo(0.3, 6),
      perCallUsd: 0.5,
      batchCapUsd: 10,
      monthSpentUsd: 0,
      monthCapUsd: null,
      withoutText: 0
    })
    const { count, batchId } = service.requestSuggestions(id, 'title_abstract')
    expect(count).toBe(45)
    const specs = queued.map((s) => as(s, 'screen_suggest'))
    expect(specs.map((s) => s.recordIds.length)).toEqual([20, 20, 5])
    expect(specs.every((s) => s.batchId === batchId && s.phase === 'title_abstract')).toBe(true)
    expect((await service.suggestPlan(id, 'full_text')).count).toBe(0)
  })

  it('asks only about records still undecided, writes the suggestions, and does not ask again with the same protocol', async () => {
    const llm = new FakeLlmProvider([byInput])
    const { service, queued } = await setupMappings({ llm })
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [
      candidate(),
      candidate({ title: 'Masking secrets in system logs before sharing them', year: 2023, identifiers: { doi: '10.5555/mask.2023' } })
    ])
    service.requestSuggestions(id, 'title_abstract')
    const [first, second] = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    await service.decide(id, { recordId: first.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    expect(await service.runSuggestions(as(queued[0], 'screen_suggest'), signal)).toEqual({ message: 'screening_suggested' })
    expect(llm.calls[0].input).not.toContain(first.id)
    const rows = service.queue(id, { phase: 'title_abstract', filter: 'all' })
    expect(rows.find((r) => r.id === second.id)?.suggestions.title_abstract).toMatchObject({ decision: 'uncertain', justification: 'Falta información.', outdated: false })
    expect(rows.find((r) => r.id === first.id)?.suggestions.title_abstract).toBeNull()
    expect((await service.suggestPlan(id, 'title_abstract')).count).toBe(0)
  })

  it('on full text, counts the included papers that have no text yet', async () => {
    const { service, store, library } = await setupMappings()
    await store.writePaper(samplePaper(), null)
    await library.indexPaper('he2017drain')
    const id = await service.create('Logs')
    await service.addFromLibrary(id, ['he2017drain'])
    const [row] = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    expect(await service.suggestPlan(id, 'full_text')).toMatchObject({ count: 0, calls: 0, withoutText: 1 })
  })
})

describe('job guards', () => {
  it('a cancelled search logs nothing', async () => {
    const { service, queued } = await setupMappings({ routes: SEARCH_ROUTES })
    const id = await service.create('Logs')
    service.requestSearch(id, { query: 'logs', fromYear: null, toYear: null, types: [], cap: 10 })
    const controller = new AbortController()
    controller.abort()
    await expect(service.runSearch(as(queued[0], 'mapping_search'), controller.signal)).rejects.toThrow()
    expect((await service.open(id)).searches).toEqual([])
  })

  it('an included record that is already a library paper is only linked, and a record no longer included is not ingested', async () => {
    const { service, queued, store, library, resolver } = await setupMappings()
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [
      candidate({ identifiers: {} }),
      candidate({ title: 'Masking secrets in system logs before sharing them', year: 2023, identifiers: { doi: '10.5555/mask.2023' } })
    ])
    // The paper reaches the library after the record was found.
    await store.writePaper(samplePaper(), null)
    await library.indexPaper('he2017drain')
    const rows = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    for (const row of rows) await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    service.requestIngest(id)
    const specs = queued.map((s) => as(s, 'ingest_record'))
    const drain = specs.find((s) => s.recordId === rows.find((r) => r.title.startsWith('Drain'))!.id)!
    const mask = specs.find((s) => s !== drain)!
    await service.decide(id, { recordId: mask.recordId, phase: 'title_abstract', decision: 'exclude', criterion: 'E1', suggestionId: null })
    expect(await service.ingestRecord(drain, signal)).toEqual({ status: 'duplicate', paperId: 'he2017drain' })
    expect(resolver.calls).toEqual([])
    expect(service.queue(id, { phase: 'full_text', filter: 'pending' }).map((r) => r.paper_id)).toEqual(['he2017drain'])
    await expect(service.ingestRecord(mask, signal)).rejects.toThrow('not_eligible')
    expect(service.ingestPlan(id).count).toBe(0)
  })

  it('never asks about a record waiting for a duplicate answer', async () => {
    const llm = new FakeLlmProvider([])
    const { service } = await setupMappings({ llm })
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [
      candidate(),
      candidate({ identifiers: { doi: '10.5555/other.2017' } })
    ])
    const all = service.queue(id, { phase: 'title_abstract', filter: 'all' })
    expect(all.filter((r) => r.duplicate)).toHaveLength(1)
    expect((await service.suggestPlan(id, 'title_abstract')).count).toBe(1)
    await service.runSuggestions({ type: 'screen_suggest', mappingId: id, phase: 'title_abstract', recordIds: [all.find((r) => r.duplicate)!.id] }, signal)
    expect(llm.calls).toHaveLength(0)
  })
})

describe('fix round 1', () => {
  const uncertain = (req: CompleteRequest) => ({
    value: {
      suggestions: [...req.input.matchAll(/<record id="(r[0-9a-f]{12})">/g)].map((m) => ({ record: m[1], decision: 'uncertain', criterion: null, justification: 'Falta información.', quote: null }))
    },
    costUsd: 0.02,
    model: 'claude-sonnet-5'
  })

  async function twoRecords(llm: FakeLlmProvider) {
    const env = await setupMappings({ llm })
    const id = await env.service.create('Logs')
    await env.service.saveProtocol(id, draft, 1)
    await env.service.addSearch(id, { kind: 'openalex', database: 'OpenAlex', query: 'q' }, [
      candidate(),
      candidate({ title: 'Masking secrets in system logs before sharing them', year: 2023, identifiers: { doi: '10.5555/mask.2023' } })
    ])
    return { ...env, id }
  }

  it('logs the search request without the contact email or the API key', async () => {
    const { service, queued, fetch } = await setupMappings({ routes: SEARCH_ROUTES, contactEmail: 'me@example.org', openalexApiKey: 'secret-key' })
    const id = await service.create('Logs')
    service.requestSearch(id, { query: 'logs', fromYear: null, toYear: null, types: [], cap: 10 })
    await service.runSearch(as(queued[0], 'mapping_search'), signal)
    expect(fetch.calls[0].url).toContain('api_key=secret-key')
    expect(fetch.calls[0].url).toContain('mailto=me%40example.org')
    const request = (await service.open(id)).searches[0].request ?? ''
    expect(request).toBe('https://api.openalex.org/works?search=logs')
  })

  it('refuses a year range that ends before it starts', async () => {
    const { service } = await setupMappings()
    const id = await service.create('Logs')
    expect(() => service.requestSearch(id, { query: 'logs', fromYear: 2020, toYear: 2015, types: [], cap: 10 })).toThrow('invalid_edit')
  })

  it('a snowball cancelled during the lookup logs nothing', async () => {
    const { service, queued, store, library } = await setupMappings({ routes: SEARCH_ROUTES })
    await store.writePaper(samplePaper({ citations: { source: 'openalex', fetched_at: '2026-10-01T00:00:00.000Z', openalex_id: 'W2754665629', references: ['W3000000003'] } }), null)
    await library.indexPaper('he2017drain')
    const id = await service.create('Logs')
    await service.saveProtocol(id, draft, 1)
    await service.addFromLibrary(id, ['he2017drain'])
    const [row] = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    await service.decide(id, { recordId: row.id, phase: 'full_text', decision: 'include', criterion: null, suggestionId: null })
    service.requestSnowball(id, 'backward')
    const controller = new AbortController()
    const original = OpenAlexSearch.prototype.works
    const spy = vi.spyOn(OpenAlexSearch.prototype, 'works').mockImplementation(async function (this: OpenAlexSearch, ids, s) {
      const works = await original.call(this, ids, s)
      controller.abort()
      return works
    })
    try {
      await expect(service.runSnowball(as(queued[0], 'mapping_snowball'), controller.signal)).rejects.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect((await service.open(id)).searches.map((s) => s.kind)).toEqual(['library'])
  })

  it('a suggestion run cancelled after Claude answered logs the cost and writes no suggestion', async () => {
    const controller = new AbortController()
    const llm = new FakeLlmProvider([
      (req: CompleteRequest) => {
        controller.abort()
        return uncertain(req)
      }
    ])
    const { service, queued, ledger, id } = await twoRecords(llm)
    service.requestSuggestions(id, 'title_abstract')
    await expect(service.runSuggestions(as(queued[0], 'screen_suggest'), controller.signal)).rejects.toThrow()
    expect(await ledger.monthTotal()).toBeCloseTo(0.02, 6)
    expect(service.queue(id, { phase: 'title_abstract', filter: 'all' }).every((r) => r.suggestions.title_abstract === null)).toBe(true)
  })

  it('stamps suggestions with the protocol version sent, after a new version', async () => {
    const llm = new FakeLlmProvider([uncertain])
    const { service, queued, id } = await twoRecords(llm)
    const [first, second] = service.queue(id, { phase: 'title_abstract', filter: 'pending' })
    await service.decide(id, { recordId: first.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    await service.saveProtocol(id, { ...draft, objective: 'Map log anonymization.' }, 1)
    expect((await service.open(id)).protocol.version).toBe(2)
    service.requestSuggestions(id, 'title_abstract')
    await service.runSuggestions(as(queued[0], 'screen_suggest'), signal)
    const row = service.queue(id, { phase: 'title_abstract', filter: 'all' }).find((r) => r.id === second.id)!
    expect(row.suggestions.title_abstract).toMatchObject({ protocolVersion: 2, outdated: false })
  })

  it('stops the rest of the batch when the budget or the CLI quota runs out', async () => {
    for (const code of ['budget_exceeded', 'llm_quota'] as const) {
      const llm = new FakeLlmProvider([new LlmError(code)])
      const { service, queued, cancelledBatches, id } = await twoRecords(llm)
      const { batchId } = service.requestSuggestions(id, 'title_abstract')
      await expect(service.runSuggestions(as(queued[0], 'screen_suggest'), signal)).rejects.toThrow(code)
      expect(cancelledBatches).toEqual([batchId])
    }
    const llm = new FakeLlmProvider([new LlmError('llm_invalid_output')])
    const { service, queued, cancelledBatches, id } = await twoRecords(llm)
    service.requestSuggestions(id, 'title_abstract')
    await expect(service.runSuggestions(as(queued[0], 'screen_suggest'), signal)).rejects.toThrow('llm_invalid_output')
    expect(cancelledBatches).toEqual([])
  })

  it('an ingest cancelled after the paper was added still links the record', async () => {
    const { service, queued, id } = await twoRecords(new FakeLlmProvider([]))
    for (const row of service.queue(id, { phase: 'title_abstract', filter: 'pending' })) {
      await service.decide(id, { recordId: row.id, phase: 'title_abstract', decision: 'include', criterion: null, suggestionId: null })
    }
    service.requestIngest(id)
    const spec = as(queued[0], 'ingest_record')
    const controller = new AbortController()
    const library = (service as unknown as { deps: { library: { ingestMetadata: (...a: unknown[]) => Promise<unknown> } } }).deps.library
    const ingest = library.ingestMetadata.bind(library)
    library.ingestMetadata = async (...a: unknown[]) => {
      const out = await ingest(...a)
      controller.abort()
      return out
    }
    const outcome = await service.ingestRecord(spec, controller.signal)
    expect(outcome.status).toBe('added')
    expect(service.queue(id, { phase: 'full_text', filter: 'all' }).find((r) => r.id === spec.recordId)?.paper_id).toBe(outcome.paperId)
  })
})
