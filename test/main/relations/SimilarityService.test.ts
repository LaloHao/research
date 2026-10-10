import { describe, expect, it } from 'vitest'
import { embeddingInput, SimilarityService } from '../../../src/main/relations/SimilarityService'
import type { JobSpec, JobType } from '../../../src/shared/jobs'
import type { Paper } from '../../../src/shared/schemas'
import { FakeEmbeddingRuntime } from '../../helpers/embeddings'
import { setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'
import { sampleSummary } from '../../helpers/summaries'

const cit = (references: string[]) => ({ source: 'openalex' as const, fetched_at: 't', references })

async function setup(runtime: FakeEmbeddingRuntime | null, papers: Paper[]) {
  const { store, cache, library } = await setupLibrary()
  for (const paper of papers) {
    await store.writePaper(paper, null)
    await library.indexPaper(paper.id)
  }
  const enqueued: JobSpec[] = []
  const cancelled: JobType[][] = []
  let emits = 0
  const service = new SimilarityService({
    store,
    cache,
    runtime,
    enqueue: (spec) => enqueued.push(spec),
    cancelQueued: (types) => {
      cancelled.push(types)
      return 0
    },
    emit: () => void emits++
  })
  return { store, cache, library, service, enqueued, cancelled, emits: () => emits }
}

describe('embeddingInput', () => {
  it('uses title and abstract, plus problem, contribution and method once summarized', () => {
    expect(embeddingInput(samplePaper({ abstract: 'An abstract.' }), null)).toBe(`${samplePaper().title}\n\nAn abstract.`)
    expect(embeddingInput(samplePaper(), sampleSummary())).toBe(`${samplePaper().title}\n\np\n\nc\n\nm`)
  })
})

describe('SimilarityService', () => {
  it('queues embeddings only while the model is on disk, and only for changed inputs', async () => {
    const runtime = new FakeEmbeddingRuntime(false)
    const paper = samplePaper({ id: 'a2020logs', title: 'Log anonymization with named entity recognition' })
    const { store, service, enqueued } = await setup(runtime, [paper])
    expect(await service.enqueueStale()).toBe(0)
    runtime.ready = true
    expect(await service.enqueueStale()).toBe(1)
    expect(enqueued).toEqual([{ type: 'embed', paperId: 'a2020logs' }])
    expect(await service.embed('a2020logs')).toEqual({ paperId: 'a2020logs', message: 'embedded' })
    expect(runtime.embedderInstance.calls).toEqual([{ texts: ['Log anonymization with named entity recognition'], kind: 'passage' }])
    expect(await service.enqueueStale()).toBe(0)
    await store.writeSummary('a2020logs', sampleSummary(), 'body', null)
    expect(await service.enqueueStale(['a2020logs'])).toBe(1)
  })

  it('fails with model_missing without a model, and queues nothing without a runtime', async () => {
    const { service } = await setup(new FakeEmbeddingRuntime(false), [samplePaper()])
    await expect(service.embed('he2017drain')).rejects.toMatchObject({ code: 'model_missing' })
    const { service: none } = await setup(null, [samplePaper()])
    expect(await none.enqueueStale()).toBe(0)
    await expect(none.requestModelDownload()).rejects.toMatchObject({ code: 'model_missing' })
  })

  it('recomputes neighbours from content and citations, with their reasons', async () => {
    const a = samplePaper({ id: 'a2020logs', title: 'Log anonymization with named entity recognition', citations: cit(['W7', 'W8']) })
    const b = samplePaper({ id: 'b2021logs', title: 'Named entity recognition for log anonymization', citations: cit(['W7']) })
    const c = samplePaper({ id: 'c2019protein', title: 'Protein folding at scale' })
    const { cache, service, emits } = await setup(new FakeEmbeddingRuntime(true), [a, b, c])
    for (const id of ['a2020logs', 'b2021logs', 'c2019protein']) await service.embed(id)
    await service.requestRecompute()
    const similar = cache.similarFor('a2020logs')
    expect(similar[0]).toMatchObject({ other: 'b2021logs' })
    expect(similar[0].reasons).toEqual(expect.arrayContaining([{ kind: 'coupling', shared: 1 }, expect.objectContaining({ kind: 'content' })]))
    expect(cache.similarFor('c2019protein')).toEqual([])
    expect(emits()).toBeGreaterThan(0)
  })

  it('leaves the recompute to the end of a batch', async () => {
    const { cache, service, emits } = await setup(new FakeEmbeddingRuntime(true), [samplePaper()])
    const job = cache.insertJob(JSON.stringify({ type: 'embed', paperId: 'he2017drain' }), 't')
    await service.requestRecompute()
    expect(emits()).toBe(0)
    cache.updateJob(job, { state: 'done' }, 't')
    await service.afterJob('he2017drain')
    expect(emits()).toBe(1)
  })

  it('updates one changed paper incrementally, as a full recompute would, and ignores changes that change nothing', async () => {
    const a = samplePaper({ id: 'a2020logs', title: 'Log anonymization with named entity recognition', citations: cit(['W7', 'W8']) })
    const b = samplePaper({ id: 'b2021logs', title: 'Named entity recognition for log anonymization', citations: cit(['W7']) })
    const c = samplePaper({ id: 'c2019protein', title: 'Protein folding at scale', citations: cit(['W9']) })
    const { store, cache, library, service, emits } = await setup(new FakeEmbeddingRuntime(true), [a, b, c])
    for (const id of ['a2020logs', 'b2021logs', 'c2019protein']) await service.embed(id)
    await service.requestRecompute()
    expect(cache.similarFor('c2019protein')).toEqual([])

    const read = await store.readPaper('c2019protein')
    if (!read.ok) throw new Error('unreadable')
    await store.writePaper({ ...read.value, citations: cit(['W9', 'W7', 'W8']) }, read.hash)
    await library.indexPaper('c2019protein')
    await service.paperChanged('c2019protein')
    expect(cache.similarFor('c2019protein').map((x) => x.other)).toContain('a2020logs')
    const incremental = cache.allSimilar()
    await service.recompute()
    expect(cache.allSimilar()).toEqual(incremental)

    const count = emits()
    await library.indexPaper('c2019protein')
    await service.paperChanged('c2019protein')
    expect(emits()).toBe(count)
  })

  it('downloads the model with progress, then queues embeddings; removing it cancels queued ones and drops the vectors', async () => {
    const runtime = new FakeEmbeddingRuntime(false)
    const { cache, service, enqueued, cancelled } = await setup(runtime, [samplePaper()])
    const seen: number[] = []
    expect(await service.downloadModel(new AbortController().signal, (f) => seen.push(f))).toEqual({ message: 'model_downloaded' })
    expect(seen).toEqual([0.5, 1])
    expect(enqueued).toEqual([{ type: 'embed', paperId: 'he2017drain' }])
    await service.requestModelDownload()
    expect(enqueued.at(-1)).toEqual({ type: 'model_download' })
    await service.embed('he2017drain')
    await service.removeModel()
    expect(cancelled).toEqual([['embed']])
    expect(runtime.removed).toBe(1)
    expect(cache.vectorMeta('he2017drain')).toBeNull()
  })
})
