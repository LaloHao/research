import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { CitationService } from '../../../src/main/citations/CitationService'
import { OpenAlexCitations } from '../../../src/main/citations/OpenAlexCitations'
import { HttpClient } from '../../../src/main/ingest/http'
import type { JobSpec, JobType } from '../../../src/shared/jobs'
import type { Paper } from '../../../src/shared/schemas'
import { routeFetch, type Route } from '../../helpers/fakeFetch'
import { setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const DRAIN_REFS: Route = { url: /\/works\/doi:10\.1109\/icws\.2017\.13\?/, body: fx('drain.refs.openalex.json') }
const LOGHUB_REFS: Route = { url: /\/works\/doi:10\.48550\/arxiv\.2008\.06448\?/, body: fx('loghub.refs.openalex.json') }
const BATCH: Route = { url: /\/works\?filter=ids\.openalex/, body: fx('refs.batch.openalex.json') }
const SEARCH: Route = { url: /\/works\?search=/, body: fx('drain.search.openalex.json') }
const LOGHUB = samplePaper({
  id: 'zhu2020loghub',
  kind: 'preprint',
  title: 'Loghub: A Large Collection of System Log Datasets',
  year: 2020,
  identifiers: { doi: '10.48550/arxiv.2008.06448' }
})

async function setup(routes: Route[], papers: Paper[] = [samplePaper()]) {
  const { store, cache, library } = await setupLibrary()
  for (const paper of papers) {
    await store.writePaper(paper, null)
    await library.indexPaper(paper.id)
  }
  const fetch = routeFetch(routes)
  const enqueued: JobSpec[] = []
  const cancelled: JobType[][] = []
  const service = new CitationService({
    store,
    cache,
    openalex: new OpenAlexCitations(new HttpClient({ fetch, sleep: async () => {} })),
    reindex: (id) => library.indexPaper(id),
    emit: () => {},
    enqueue: (spec) => enqueued.push(spec),
    cancelQueued: (types) => {
      cancelled.push(types)
      return 0
    },
    pauseMs: 0,
    now: () => new Date('2026-10-09T12:00:00.000Z')
  })
  return { store, cache, service, fetch, enqueued, cancelled }
}

describe('CitationService.fetch', () => {
  it('writes the references of a paper (found by DOI) to paper.yaml and the index', async () => {
    const { store, cache, service } = await setup([DRAIN_REFS])
    expect(await service.fetch('he2017drain')).toEqual({ paperId: 'he2017drain', message: 'citations_updated' })
    const raw = parse(await readFile(join(store.paperDir('he2017drain'), 'paper.yaml'), 'utf8'))
    expect(raw.citations).toEqual({
      source: 'openalex',
      fetched_at: '2026-10-09T12:00:00.000Z',
      openalex_id: 'W2754665629',
      references: ['W66551789', 'W1532325895', 'W2153470728', 'W2527994611'],
      cited_by_count: 904
    })
    expect(cache.getPaper('he2017drain')?.citations_status).toBe('ok')
    expect(cache.citationEdges()).toHaveLength(4)
  })

  it('resolves a paper without a DOI by its exact title and year', async () => {
    const { service, fetch } = await setup([SEARCH, { url: /\/works\/W2754665629\?/, body: fx('drain.refs.openalex.json') }], [samplePaper({ identifiers: {} })])
    expect((await service.fetch('he2017drain')).message).toBe('citations_updated')
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/works', '/works/W2754665629'])
  })

  it('marks a paper unresolved when nothing matches, and never searches for web pages', async () => {
    const note = samplePaper({ id: 'doe2020note', title: 'An unpublished note on logs', year: 2020, identifiers: {} })
    const page = samplePaper({ id: 'acme2024postmortem', kind: 'web', title: 'Postmortem of the March outage', identifiers: { url: 'https://example.com/pm' } })
    const { store, cache, service, fetch } = await setup([SEARCH], [note, page])
    expect((await service.fetch('doe2020note')).message).toBe('citations_unresolved')
    expect(cache.getPaper('doe2020note')?.citations_status).toBe('unresolved')
    const read = await store.readPaper('doe2020note')
    expect(read.ok && read.value.citations).toMatchObject({ source: 'openalex', unresolved: true })
    const before = fetch.calls.length
    expect((await service.fetch('acme2024postmortem')).message).toBe('citations_unresolved')
    expect(fetch.calls.length).toBe(before)
  })

  it('prefers the OpenAlex id in identifiers over the one of a previous fetch', async () => {
    const stale = { source: 'openalex' as const, fetched_at: '2026-01-01T00:00:00.000Z', openalex_id: 'W1', references: [], cited_by_count: 0 }
    const { service, fetch } = await setup([{ url: /\/works\/W2754665629\?/, body: fx('drain.refs.openalex.json') }], [samplePaper({ identifiers: { doi: '10.1109/icws.2017.13', openalex: 'W2754665629' }, citations: stale })])
    expect((await service.fetch('he2017drain')).message).toBe('citations_updated')
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/works/W2754665629'])
  })

  it('falls back to the DOI when the known OpenAlex work has another DOI', async () => {
    const stale = { source: 'openalex' as const, fetched_at: '2026-01-01T00:00:00.000Z', openalex_id: 'W2754665629', references: ['W1'], cited_by_count: 1 }
    const { store, service } = await setup([{ url: /\/works\/W2754665629\?/, body: fx('drain.refs.openalex.json') }, LOGHUB_REFS], [{ ...LOGHUB, citations: stale }])
    expect((await service.fetch('zhu2020loghub')).message).toBe('citations_updated')
    const read = await store.readPaper('zhu2020loghub')
    expect(read.ok && read.value.citations?.openalex_id).toBe('W3049160591')
  })

  it('fails with openalex_limit and cancels the pending citation jobs', async () => {
    const { service, cancelled } = await setup([{ url: /\/works\/doi:/, status: 429, headers: { 'x-ratelimit-remaining': '0' } }])
    await expect(service.fetch('he2017drain')).rejects.toMatchObject({ code: 'openalex_limit' })
    expect(cancelled).toEqual([['citations', 'cited_by']])
  })
})

describe('CitationService candidates', () => {
  it('lists references shared by the library with cached metadata, and forgets dismissed ones', async () => {
    const { store, service, fetch } = await setup([DRAIN_REFS, LOGHUB_REFS, BATCH], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    const list = await service.candidates({ direction: 'references', minCount: 2 })
    expect(list.metadataError).toBeNull()
    expect(list.candidates.map((c) => [c.openalexId, c.citedByLibrary, c.work?.title])).toEqual([
      ['W1532325895', 2, 'Introduction to information retrieval'],
      ['W2153470728', 2, 'LogSig']
    ])
    const batches = (): number => fetch.calls.filter((c) => c.url.includes('ids.openalex')).length
    const before = batches()
    await service.candidates({ direction: 'references', minCount: 2 })
    expect(batches()).toBe(before)

    await service.dismiss('W1532325895')
    expect(store.config.snowball.dismissed).toEqual(['W1532325895'])
    expect((await service.candidates({ direction: 'references', minCount: 2 })).candidates.map((c) => c.openalexId)).toEqual(['W2153470728'])
  })

  it('stores works OpenAlex does not return, so they are not requested again', async () => {
    const { cache, service, fetch } = await setup([DRAIN_REFS, LOGHUB_REFS, BATCH], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    const batches = (): number => fetch.calls.filter((c) => c.url.includes('ids.openalex')).length
    const list = await service.candidates({ direction: 'references', minCount: 1 })
    expect(cache.externalWorks(['W66551789']).get('W66551789')).toMatchObject({ title: null, doi: null })
    expect(list.candidates.find((c) => c.openalexId === 'W2153470728')?.work?.title).toBe('LogSig')
    const before = batches()
    await service.candidates({ direction: 'references', minCount: 1 })
    expect(batches()).toBe(before)
  })

  it('runs simultaneous identical requests once', async () => {
    const { service, fetch } = await setup([DRAIN_REFS, LOGHUB_REFS, BATCH], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    const query = { direction: 'references' as const, minCount: 2 }
    const [a, b] = await Promise.all([service.candidates(query), service.candidates(query)])
    expect(a).toBe(b)
    expect(fetch.calls.filter((c) => c.url.includes('ids.openalex'))).toHaveLength(1)
  })

  it('still lists candidates when their metadata cannot be fetched', async () => {
    const { service } = await setup([DRAIN_REFS, LOGHUB_REFS, { url: /\/works\?filter=ids\.openalex/, status: 429, headers: { 'x-ratelimit-remaining': '0' } }], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    const list = await service.candidates({ direction: 'references', minCount: 2 })
    expect(list.metadataError).toBe('openalex_limit')
    expect(list.candidates.map((c) => c.work)).toEqual([null, null])
  })

  it('keeps the metadata of the batches fetched before one fails', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `W${1000000 + i}`)
    const refs = { source: 'openalex' as const, fetched_at: '2026-01-01T00:00:00.000Z', openalex_id: 'W2754665629', references: ids, cited_by_count: 0 }
    const first = JSON.stringify({ results: [{ id: 'https://openalex.org/W1000000', title: 'First', publication_year: 2020, authorships: [], cited_by_count: 3 }] })
    const { cache, service } = await setup(
      [
        { url: /ids\.openalex.*W1000100/, status: 429, headers: { 'x-ratelimit-remaining': '0' } },
        { url: /ids\.openalex/, body: first }
      ],
      [samplePaper({ citations: refs })]
    )
    const list = await service.candidates({ direction: 'references', minCount: 1 })
    expect(list.metadataError).toBe('openalex_limit')
    const works = cache.externalWorks(ids)
    expect(works.get('W1000000')?.title).toBe('First')
    expect(works.get('W1000099')).toMatchObject({ title: null })
    expect(works.has('W1000100')).toBe(false)
  })

  it('also cancels the pending citation jobs when the metadata hits the daily limit', async () => {
    const { service, cancelled } = await setup([DRAIN_REFS, LOGHUB_REFS, { url: /\/works\?filter=ids\.openalex/, status: 429, headers: { 'x-ratelimit-remaining': '0' } }], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    await service.candidates({ direction: 'references', minCount: 2 })
    expect(cancelled).toEqual([['citations', 'cited_by']])
  })

  it('records simultaneous dismissals without a conflict', async () => {
    const { store, service } = await setup([])
    await Promise.all([service.dismiss('W1532325895'), service.dismiss('W2153470728')])
    expect(store.config.snowball.dismissed).toEqual(['W1532325895', 'W2153470728'])
  })

  it('adds a candidate by DOI, or by its OpenAlex id when it has none', async () => {
    const { service, enqueued } = await setup([DRAIN_REFS, LOGHUB_REFS, BATCH], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    await service.candidates({ direction: 'references', minCount: 2 })
    service.add('W2153470728')
    service.add('W66551789')
    expect(enqueued.slice(-2)).toEqual([
      { type: 'ingest_identifier', input: '10.1145/2063576.2063690' },
      { type: 'ingest_identifier', input: 'W66551789' }
    ])
  })

  it('collects the works citing a paper, page by page', async () => {
    const { service, cache } = await setup(
      [
        LOGHUB_REFS,
        BATCH,
        { url: /cites%3AW3049160591.*cursor=\*/, body: fx('loghub.cites-1.openalex.json') },
        { url: /cursor=IlsxMDAu/, body: fx('loghub.cites-2.openalex.json') }
      ],
      [LOGHUB]
    )
    await service.fetch('zhu2020loghub')
    expect(await service.fetchCitedBy('zhu2020loghub')).toEqual({ paperId: 'zhu2020loghub', message: 'cited_by_updated' })
    expect(cache.incomingEdges().map((e) => e.citing)).toEqual(['W3121951581', 'W3199174176', 'W4226128225'])
    const list = await service.candidates({ direction: 'citing', minCount: 1 })
    expect(list.candidates.map((c) => c.openalexId).sort()).toEqual(['W3121951581', 'W3199174176', 'W4226128225'])
    expect(list.candidates.every((c) => c.citesLibrary === 1)).toBe(true)
  })
})

describe('CitationService requests', () => {
  it('queues citation jobs for all papers, some papers, new papers and cited-by lookups', async () => {
    const { service, enqueued } = await setup([], [samplePaper(), LOGHUB])
    expect(service.requestUpdate()).toBe(2)
    expect(service.requestUpdate(['zhu2020loghub'])).toBe(1)
    service.autoAfterIngest('he2017drain')
    expect(enqueued.at(-1)).toEqual({ type: 'citations', paperId: 'he2017drain' })
    expect(service.requestCitedBy()).toBe(0)
    expect(enqueued.filter((s) => s.type === 'citations' && s.batchId)).toHaveLength(3)
  })

  it('skips papers whose citing works were fetched in the last 7 days', async () => {
    const { service, cache, enqueued } = await setup([DRAIN_REFS, LOGHUB_REFS], [samplePaper(), LOGHUB])
    await service.fetch('he2017drain')
    await service.fetch('zhu2020loghub')
    cache.setIncoming('he2017drain', [], '2026-10-05T12:00:00.000Z')
    cache.setIncoming('zhu2020loghub', ['W1'], '2026-09-30T12:00:00.000Z')
    expect(service.requestCitedBy()).toBe(1)
    expect(enqueued.at(-1)).toMatchObject({ type: 'cited_by', paperId: 'zhu2020loghub' })
    expect(service.requestCitedBy({ force: true })).toBe(2)
  })
})
