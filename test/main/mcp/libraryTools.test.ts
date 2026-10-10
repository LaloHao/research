import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import type { EmbeddingRuntime } from '../../../src/main/embeddings/EmbeddingRuntime'
import { MapService } from '../../../src/main/map/MapService'
import { libraryTools, ToolError } from '../../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { FakeEmbeddingRuntime, fakeVector } from '../../helpers/embeddings'
import { DRAIN_ID, DRAIN_PAGES, drainPaper, LOGHUB_ID, LOGHUB_PAGES, seedPair } from '../../helpers/pair'
import { tmpDir } from '../../helpers/tmp'

async function setup(embeddings: EmbeddingRuntime | null = null) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const tools = libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings })
  return { store, cache, tools }
}

describe('libraryTools', () => {
  it('searches the indexed text across papers or within one', async () => {
    const { tools } = await setup()
    expect((await tools.searchText('drain')).map((h) => h.paper_id).sort()).toEqual([DRAIN_ID, DRAIN_ID, LOGHUB_ID])
    expect(await tools.searchText('sixteen', LOGHUB_ID)).toEqual([{ paper_id: LOGHUB_ID, page: 2, text: LOGHUB_PAGES[1] }])
    await expect(tools.searchText('!!')).rejects.toBeInstanceOf(ToolError)
    await expect(tools.searchText('drain', 'nope2020x')).rejects.toThrow(/Unknown paper id "nope2020x"/)
  })

  it('finds literal text in one paper, ignoring case and accents, with page and context as written', async () => {
    const { tools, cache } = await setup()
    expect(await tools.findInPaper(LOGHUB_ID, 'EXTEND its')).toEqual([{ page: 2, match: 'extend its', context: LOGHUB_PAGES[1] }])
    expect(await tools.findInPaper(LOGHUB_ID, 'extend\\w*')).toEqual([])
    cache.setText(DRAIN_ID, 'x', 'ok', [{ index: 0, page: 1, text: 'Un análisis de registros. Otro ANÁLISIS.' }])
    expect((await tools.findInPaper(DRAIN_ID, 'analisis')).map((h) => [h.page, h.match])).toEqual([
      [1, 'análisis'],
      [1, 'ANÁLISIS']
    ])
    await expect(tools.findInPaper(LOGHUB_ID, 'a')).rejects.toBeInstanceOf(ToolError)
    await expect(tools.findInPaper(LOGHUB_ID, 'x'.repeat(201))).rejects.toBeInstanceOf(ToolError)
  })

  it('reads a range of pages, at most five at a time', async () => {
    const { tools } = await setup()
    expect(await tools.readPages(DRAIN_ID, 2, 2)).toEqual({ paper_id: DRAIN_ID, pages: [{ page: 2, text: DRAIN_PAGES[1] }] })
    expect((await tools.readPages(DRAIN_ID, 1, 5)).pages).toHaveLength(2)
    await expect(tools.readPages(DRAIN_ID, 1, 6)).rejects.toThrow(/at most 5 pages/)
    await expect(tools.readPages(DRAIN_ID, 2, 1)).rejects.toBeInstanceOf(ToolError)
  })

  it('describes a paper with its metadata, summary and facets, and never a file path', async () => {
    const { tools, store } = await setup()
    const card = await tools.getPaper(LOGHUB_ID)
    expect(card).toMatchObject({ paper_id: LOGHUB_ID, title: 'Loghub: A Large Collection of System Log Datasets', year: 2020, abstract: 'A collection of log datasets.', summary: null, facets: {}, pages: 2 })
    expect(JSON.stringify(card)).not.toContain(store.root)
  })

  it('lists citations inside the library and neighbours with their reasons', async () => {
    const { tools, cache } = await setup()
    expect((await tools.getCitations(LOGHUB_ID)).cites).toEqual([{ paper_id: DRAIN_ID, title: drainPaper().title, year: 2017 }])
    expect((await tools.getCitations(DRAIN_ID)).cited_by.map((p) => p.paper_id)).toEqual([LOGHUB_ID])
    const reasons = [{ kind: 'direct' as const, citing: LOGHUB_ID, cited: DRAIN_ID }]
    cache.setSimilarRows(new Map([[LOGHUB_ID, [{ a: LOGHUB_ID, b: DRAIN_ID, score: 0.7, reasons }]]]))
    expect(await tools.getNeighbours(LOGHUB_ID)).toEqual({ paper_id: LOGHUB_ID, similar: [{ paper_id: DRAIN_ID, title: drainPaper().title, year: 2017, score: 0.7, reasons }] })
  })

  it('ranks papers by meaning when the local model is ready, and says so when it is not', async () => {
    const { tools, cache } = await setup(new FakeEmbeddingRuntime(true))
    cache.setVector(DRAIN_ID, 'h', 'fake-embedder', fakeVector(DRAIN_PAGES.join(' ')))
    cache.setVector(LOGHUB_ID, 'h', 'fake-embedder', fakeVector(LOGHUB_PAGES.join(' ')))
    expect((await tools.searchSimilar('fixed depth parse tree'))[0].paper_id).toBe(DRAIN_ID)
    await expect((await setup(new FakeEmbeddingRuntime(false))).tools.searchSimilar('tree')).rejects.toThrow(/unavailable/)
    await expect((await setup(null)).tools.searchSimilar('tree')).rejects.toThrow(/unavailable/)
  })
})
