import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { CitationSuggester } from '../../../src/main/writing/CitationSuggester'
import { WritingService } from '../../../src/main/writing/WritingService'
import type { ProjectStore } from '../../../src/main/project/ProjectStore'
import { FakeEmbedder, fakeVector } from '../../helpers/embeddings'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES } from '../../helpers/pair'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

const DEEPLOG_ID = 'du2017deeplog'
const NOTEXT_ID = 'doe2021notext'
const TRASHED_ID = 'old2010trash'
const DEEPLOG_PAGES = ['DeepLog models system logs with an LSTM network.', 'Anomaly detection on HDFS system logs reaches high recall. It needs no labels.']
const TRASHED_PAGES = ['Anomaly detection on system logs reaches high recall, always.']
const SENTENCE = 'La detección de anomalías en los logs del sistema alcanza un alto recall (anomaly detection, system logs, recall).'

/** Drain, Loghub and DeepLog with text and vectors; a paper without text and a trashed one, both with a vector right on the sentence. */
async function library() {
  const cache = IndexCache.open(join(await tmpDir(), 'index.sqlite'))
  const add = (id: string, title: string, year: number, pages: string[] | null, vectorText: string) => {
    cache.upsertPaper(samplePaper({ id, title, year }), 'h', false)
    if (pages) cache.setText(id, `t-${id}`, 'ok', pages.map((text, i) => ({ index: i, page: i + 1, text })))
    cache.setVector(id, `v-${id}`, 'fake-embedder', fakeVector(vectorText))
  }
  add(DRAIN_ID, 'Drain: An Online Log Parsing Approach', 2017, DRAIN_PAGES, DRAIN_PAGES.join(' '))
  add(LOGHUB_ID, 'Loghub', 2020, LOGHUB_PAGES, LOGHUB_PAGES.join(' '))
  add(DEEPLOG_ID, 'DeepLog: Anomaly Detection from System Logs', 2017, DEEPLOG_PAGES, DEEPLOG_PAGES.join(' '))
  add(NOTEXT_ID, 'No text', 2021, null, SENTENCE)
  add(TRASHED_ID, 'Trashed', 2010, TRASHED_PAGES, SENTENCE)
  cache.moveToTrash({ id: TRASHED_ID, title: 'Trashed', authors_label: '', year: 2010, doi: null, openalex_id: null, trashed_at: null, device: null, problem: null })
  return cache
}

const service = (cache: IndexCache, embedder: FakeEmbedder | null) =>
  new WritingService({ store: {} as ProjectStore, cache, includedPapers: () => [], embedder: async () => embedder })

describe('CitationSuggester', () => {
  it('suggests the paper whose passage supports the sentence, with its page and best sentence, ranked by meaning and words', async () => {
    const cache = await library()
    const embedder = new FakeEmbedder()
    const [out] = await service(cache, embedder).suggestCitations([{ text: SENTENCE, exclude: [DRAIN_ID] }], 3)
    expect(out.semantic).toBe(true)
    expect(out.suggestions[0]).toEqual({
      key: DEEPLOG_ID,
      title: 'DeepLog: Anomaly Detection from System Logs',
      year: 2017,
      page: 2,
      quote: 'Anomaly detection on HDFS system logs reaches high recall.',
      score: expect.any(Number)
    })
    expect(out.suggestions[0].score).toBeGreaterThan(0)
    expect(out.suggestions[0].score).toBeLessThanOrEqual(1)
    expect(out.suggestions.length).toBeLessThanOrEqual(3)
    // Scores never increase down the list.
    const scores = out.suggestions.map((s) => s.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    // The sentences are embedded in one call, and each paper's windows once.
    expect(embedder.calls.filter((c) => c.kind === 'query')).toHaveLength(1)
  })

  it('leaves out the keys the sentence cites, trashed papers and papers without text', async () => {
    const cache = await library()
    const [out] = await service(cache, new FakeEmbedder()).suggestCitations([{ text: SENTENCE, exclude: [DEEPLOG_ID] }], 5)
    const keys = out.suggestions.map((s) => s.key)
    expect(keys).not.toContain(DEEPLOG_ID)
    expect(keys).not.toContain(NOTEXT_ID)
    expect(keys).not.toContain(TRASHED_ID)
  })

  it('works by words only without the local model', async () => {
    const cache = await library()
    const [out, other] = await service(cache, null).suggestCitations(
      [{ text: 'Anomaly detection on system logs reaches high recall.' }, { text: 'We evaluate the parser on sixteen datasets.', exclude: [] }],
      2
    )
    expect(out.semantic).toBe(false)
    expect(out.suggestions[0]).toMatchObject({ key: DEEPLOG_ID, page: 2 })
    expect(out.suggestions.map((s) => s.key)).not.toContain(TRASHED_ID)
    expect(other.suggestions[0]).toMatchObject({ key: LOGHUB_ID, page: 2, quote: 'We evaluate Drain on all sixteen Loghub datasets and extend its parser.' })
  })

  it('answers an empty list for a sentence nothing matches, and goes on when the model fails', async () => {
    const cache = await library()
    const broken = new CitationSuggester({
      papers: () => [{ id: DEEPLOG_ID, title: 'DeepLog', year: 2017, hasText: true }],
      vectors: (m) => cache.vectors(m),
      searchChunks: (q, limit) => cache.searchChunks(q, { limit }),
      chunks: (id) => cache.chunksFor(id),
      embedder: async () => ({ modelId: 'fake-embedder', dims: 16, embed: async () => Promise.reject(new Error('boom')) })
    })
    const [none, some] = await broken.suggest([{ text: 'Zzzq qqqz wwwx.' }, { text: 'Anomaly detection with high recall.' }], 3)
    expect(none).toEqual({ semantic: false, suggestions: [] })
    expect(some.semantic).toBe(false)
    expect(some.suggestions.map((s) => s.key)).toEqual([DEEPLOG_ID])
  })
})
