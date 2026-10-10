import { describe, expect, it } from 'vitest'
import { MapService } from '../../../src/main/map/MapService'
import { DEFAULT_EXTRACTION_FORM } from '../../../src/main/summary/extractionForm'
import { setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'
import { sampleExtraction } from '../../helpers/summaries'

const cit = (openalex_id: string, references: string[]) => ({
  source: 'openalex' as const,
  fetched_at: '2026-10-09T12:00:00.000Z',
  openalex_id,
  references,
  cited_by_count: 10
})

async function setup() {
  const { store, cache, library } = await setupLibrary()
  await store.updateConfig({ extraction_form: DEFAULT_EXTRACTION_FORM })
  await store.writePaper(samplePaper({ citations: cit('W2754665629', ['W1532325895', 'W66551789']) }), null)
  await store.writePaper(
    samplePaper({
      id: 'zhu2020loghub',
      title: 'Loghub',
      year: 2020,
      identifiers: { doi: '10.48550/arxiv.2008.06448' },
      citations: cit('W3049160591', ['W2754665629', 'W1532325895'])
    }),
    null
  )
  await store.writeExtraction('he2017drain', sampleExtraction({ task: { values: ['log_parsing'], proposed: [], status: 'verified', evidence: [] } }), null)
  for (const id of ['he2017drain', 'zhu2020loghub']) await library.indexPaper(id)
  const reasons = [{ kind: 'coupling' as const, shared: 1 }]
  cache.replaceSimilar([
    { a: 'he2017drain', b: 'zhu2020loghub', score: 0.6, reasons },
    { a: 'zhu2020loghub', b: 'he2017drain', score: 0.6, reasons }
  ])
  return new MapService({ store, cache })
}

describe('MapService', () => {
  it('describes the relations of one paper', async () => {
    const map = await setup()
    const drain = await map.relations('he2017drain')
    expect(drain.citations?.openalex_id).toBe('W2754665629')
    expect(drain.cites).toEqual([])
    expect(drain.citedBy).toEqual([{ id: 'zhu2020loghub', title: 'Loghub', year: 2020 }])
    expect(drain.similar).toEqual([{ id: 'zhu2020loghub', title: 'Loghub', year: 2020, score: 0.6, reasons: [{ kind: 'coupling', shared: 1 }] }])
    expect(drain.externalReferences).toBe(2)
    const loghub = await map.relations('zhu2020loghub')
    expect(loghub.cites.map((p) => p.id)).toEqual(['he2017drain'])
    expect(loghub.externalReferences).toBe(1)
  })

  it('builds the graph: nodes with facets, internal citations and one similarity edge per pair', async () => {
    const graph = (await setup()).graph()
    expect(graph.nodes.map((n) => [n.id, n.citedByCount, n.facets, n.thesisScore])).toEqual([
      ['he2017drain', 10, { task: ['log_parsing'] }, null],
      ['zhu2020loghub', 10, {}, null]
    ])
    expect(graph.citations).toEqual([{ source: 'zhu2020loghub', target: 'he2017drain' }])
    expect(graph.similarities).toEqual([{ source: 'he2017drain', target: 'zhu2020loghub', score: 0.6, reasons: [{ kind: 'coupling', shared: 1 }] }])
  })

  it('answers chart queries, facet filters and facet options from the index', async () => {
    const map = await setup()
    expect(map.chart({ kind: 'bars', facet: 'task', onlyReviewed: true })).toEqual({
      kind: 'bars',
      facet: 'task',
      bars: [{ value: 'log_parsing', reviewed: 1, unreviewed: 0 }]
    })
    expect(map.facetPaperIds([{ facet: 'task', value: 'log_parsing' }])).toEqual(['he2017drain'])
    expect(map.facetOptions().map((f) => f.key)).toEqual(['sanitization_technique', 'data_type', 'llm_usage', 'task'])
  })
})
