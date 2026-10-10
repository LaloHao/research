import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ProjectSession } from '../../../src/main/library/ProjectSession'
import { FakeEmbeddingRuntime } from '../../helpers/embeddings'
import { routeFetch, type Route } from '../../helpers/fakeFetch'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/http/${name}`, import.meta.url), 'utf8')
const DRAIN_ROUTES: Route[] = [
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/vnd.citationstyles.csl+json', body: fx('drain.csl.json') },
  { url: 'https://doi.org/10.1109/icws.2017.13', accept: 'application/x-bibtex', body: fx('drain.bib') },
  { url: 'https://api.openalex.org/works/doi:10.1109/icws.2017.13', body: fx('drain.openalex.json') },
  { url: /\/works\/W2754665629\?select=/, body: fx('drain.refs.openalex.json') }
]
const base = { contactEmail: '', watch: false, citationPauseMs: 0 }

describe('ProjectSession relations', () => {
  it('fetches citations after adding a paper', async () => {
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, fetch: routeFetch(DRAIN_ROUTES) })
    s.queue.enqueue({ type: 'ingest_identifier', input: '10.1109/ICWS.2017.13' })
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => [j.spec.type, j.state, j.message])).toEqual([
      ['citations', 'done', 'citations_updated'],
      ['ingest_identifier', 'done', 'added']
    ])
    expect(s.library.list()[0].citations_status).toBe('ok')
    const read = await s.store.readPaper('he2017drain')
    expect(read.ok && read.value.citations?.references).toHaveLength(4)
    await s.close()
  })

  it('embeds papers through the queue and stores their neighbours', async () => {
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, fetch: routeFetch([]), embeddings: new FakeEmbeddingRuntime(true) })
    for (const paper of [
      samplePaper({ id: 'a2020logs', title: 'Log anonymization with named entity recognition' }),
      samplePaper({ id: 'b2021logs', title: 'Named entity recognition for log anonymization' })
    ]) {
      await s.store.writePaper(paper, null)
      await s.library.indexPaper(paper.id)
    }
    expect(await s.similarity.enqueueStale()).toBe(2)
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => j.message)).toEqual(['embedded', 'embedded'])
    expect(s.cache.similarFor('a2020logs').map((x) => x.other)).toEqual(['b2021logs'])
    await s.close()
  })

  it('downloads the model as a job, then embeds the library', async () => {
    const runtime = new FakeEmbeddingRuntime(false)
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, fetch: routeFetch([]), embeddings: runtime })
    await s.store.writePaper(samplePaper(), null)
    await s.library.indexPaper('he2017drain')
    await s.similarity.requestModelDownload()
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => [j.spec.type, j.message]).sort()).toEqual([
      ['embed', 'embedded'],
      ['model_download', 'model_downloaded']
    ])
    await s.close()
  })

  it("cancels the pending citation jobs when OpenAlex's daily limit is reached", async () => {
    const s = await ProjectSession.create(await tmpDir(), 'Thesis', { ...base, fetch: routeFetch([{ url: /api\.openalex\.org/, status: 429, headers: { 'x-ratelimit-remaining': '0' } }]) })
    for (const paper of [samplePaper(), samplePaper({ id: 'zhu2020loghub', title: 'Loghub', identifiers: { doi: '10.48550/arxiv.2008.06448' } })]) {
      await s.store.writePaper(paper, null)
      await s.library.indexPaper(paper.id)
    }
    expect(s.citations.requestUpdate()).toBe(2)
    await s.queue.whenIdle()
    expect(s.queue.list().map((j) => [j.state, j.message]).sort()).toEqual([
      ['cancelled', null],
      ['failed', 'openalex_limit']
    ])
    await s.close()
  })
})
