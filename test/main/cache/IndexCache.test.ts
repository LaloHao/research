import { buildPaperText } from '../../../src/main/summary/paperText'
import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import type { Citations } from '../../../src/shared/relations'
import { relationId, type TypedRelation } from '../../../src/shared/typedRelations'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

async function openCache(): Promise<{ cache: IndexCache; file: string }> {
  const file = join(await tmpDir(), '.cache', 'index.sqlite')
  return { cache: IndexCache.open(file), file }
}

const typed = (from: string, to: string, over: Partial<TypedRelation> = {}): TypedRelation => ({
  id: relationId(from, to, 'extends'),
  type: 'extends',
  from,
  to,
  status: 'suggested',
  edited: false,
  justification: 'j',
  evidence: [{ paper: from, page: 1, quote: 'q', found: true }],
  updated_at: '2026-10-10T00:00:00.000Z',
  ...over
})

describe('IndexCache papers', () => {
  it('keeps how many form facets a paper has not filled yet', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', true)
    expect(cache.getPaper('he2017drain')?.unfilled_facets).toBe(0)
    cache.setSummaryState('he2017drain', 'generated', 2, '', 'm', 3)
    expect(cache.getPaper('he2017drain')).toMatchObject({ summary_status: 'generated', unfilled_facets: 3 })
    cache.setSummaryState('he2017drain', 'reviewed', 0, '', 'm')
    expect(cache.getPaper('he2017drain')?.unfilled_facets).toBe(0)
  })

  it('migrates a schema 8 cache in place, keeping its rows (and so its text and vectors)', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO papers (id, title) VALUES ('he2017drain', 'Drain'); PRAGMA user_version = 8")
    db.close()
    IndexCache.open(file).close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
    expect(check.prepare('SELECT id, unfilled_facets FROM papers').all().map((r) => ({ ...r }))).toEqual([{ id: 'he2017drain', unfilled_facets: 0 }])
    check.close()
  })

  it('upserts and lists papers with a display label', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h1', false)
    expect(cache.listPapers()).toEqual([
      expect.objectContaining({ id: 'he2017drain', authors_label: 'He & Zhu', year: 2017, has_pdf: false, problem: null, text_status: 'pending' })
    ])
    expect(cache.fileHash('he2017drain')).toBe('h1')
  })

  it('keeps text status across metadata updates and survives reopening', async () => {
    const { cache, file } = await openCache()
    cache.upsertPaper(samplePaper(), 'h1', true)
    cache.setText('he2017drain', 't1', 'ok', [{ index: 0, page: 1, text: 'pseudonymization of identifiers' }])
    cache.upsertPaper(samplePaper({ title: 'Drain v2' }), 'h2', true)
    cache.close()
    const reopened = IndexCache.open(file)
    expect(reopened.getPaper('he2017drain')).toMatchObject({ title: 'Drain v2', text_status: 'ok' })
    expect(reopened.textHash('he2017drain')).toBe('t1')
  })

  it('records file problems as rows titled by id', async () => {
    const { cache } = await openCache()
    cache.setProblem('broken2020x', 'h', { kind: 'conflict_markers', message: 'File contains git conflict markers' })
    expect(cache.getPaper('broken2020x')).toMatchObject({ title: 'broken2020x', problem: 'conflict_markers: File contains git conflict markers' })
  })

  it('removes papers with their chunks', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h1', false)
    cache.setText('he2017drain', 't', 'ok', [{ index: 0, page: 1, text: 'unique token zyxw' }])
    cache.removePaper('he2017drain')
    expect(cache.paperIds()).toEqual([])
    expect(cache.search('zyxw')).toEqual([])
  })

  it('exposes dedupe entries', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper({ identifiers: { doi: '10.1/x', arxiv: '2008.06448' } }), 'h', false)
    expect(cache.dedupeEntries()).toEqual([{ id: 'he2017drain', doi: '10.1/x', arxiv: '2008.06448', title: samplePaper().title }])
  })

  it('rebuilds a corrupted cache file instead of failing', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    await writeFile(file, 'this is not a database '.repeat(200))
    const cache = IndexCache.open(file)
    expect(cache.listPapers()).toEqual([])
  })
})

describe('IndexCache search', () => {
  it('finds papers by metadata or by chunk text, folding accents, metadata first', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper({ id: 'a2020pseudo', title: 'Pseudonymization of production logs' }), 'h', false)
    cache.upsertPaper(samplePaper({ id: 'b2021other', title: 'Another study' }), 'h', false)
    cache.setText('b2021other', 't', 'ok', [{ index: 0, page: 4, text: 'We discuss pseudonymization briefly.' }])
    cache.upsertPaper(samplePaper({ id: 'c2022anon', title: 'Anonimización de registros' }), 'h', false)
    expect(cache.search('pseudonymization')).toEqual(['a2020pseudo', 'b2021other'])
    expect(cache.search('anonimizacion')).toEqual(['c2022anon'])
    expect(cache.search('pseudo')).toContain('a2020pseudo')
  })

  it('returns nothing for a query without words', async () => {
    const { cache } = await openCache()
    expect(cache.search('  "*" ')).toEqual([])
  })
})

describe('IndexCache jobs', () => {
  it('queues, updates and requeues jobs', async () => {
    const { cache } = await openCache()
    const a = cache.insertJob('{"type":"ingest_identifier","input":"x"}', 't0')
    const b = cache.insertJob('{"type":"ingest_identifier","input":"y"}', 't0')
    expect(cache.nextQueuedJob()?.id).toBe(a)
    cache.updateJob(a, { state: 'running' }, 't1')
    expect(cache.nextQueuedJob()?.id).toBe(b)
    cache.requeueRunningJobs('t2')
    expect(cache.getJob(a)).toMatchObject({ state: 'queued', updated_at: 't2' })
    cache.updateJob(a, { state: 'done', paper_id: 'he2017drain', message: 'added' }, 't3')
    expect(cache.listJobs().map((j) => j.id)).toEqual([b, a])
    expect(cache.getJob(a)).toMatchObject({ state: 'done', paper_id: 'he2017drain', message: 'added' })
  })
})

describe('IndexCache v2: summaries', () => {
  it('measures the text without its reference list, as the too-long check does', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', true)
    const body = 'Body text of the paper. '.repeat(40)
    const chunks = [
      { index: 0, page: 1, text: body },
      { index: 1, page: 2, text: `${body} References` },
      { index: 2, page: 3, text: '[1] A. Author. Some paper. 2020. '.repeat(5) }
    ]
    cache.setText('he2017drain', 't', 'ok', chunks)
    expect(cache.textChars('he2017drain')).toBe(buildPaperText(chunks, { maxChars: Infinity }).chars)
    expect(cache.textChars('he2017drain')).toBeLessThan(body.length * 2 + 30)
  })

  it('stores text size, chunks in order and summary state', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', true)
    cache.setText('he2017drain', 't', 'ok', [
      { index: 0, page: 1, text: 'first' },
      { index: 1, page: 2, text: 'second part' }
    ])
    // The size the too-long check uses: the text as sent, with page markers.
    expect(cache.textChars('he2017drain')).toBe('[p.1]\nfirst\n\n[p.2]\nsecond part'.length)
    expect(cache.chunksFor('he2017drain')).toEqual([
      { page: 1, text: 'first' },
      { page: 2, text: 'second part' }
    ])
    cache.setSummaryState('he2017drain', 'generated', 7, 'differential privacy keeps referential integrity', 'claude-haiku-4-5')
    expect(cache.getPaper('he2017drain')).toMatchObject({ summary_status: 'generated', pending_review: 7, summary_model: 'claude-haiku-4-5' })
    expect(cache.search('referential')).toEqual(['he2017drain'])
  })

  it('remembers the last summary error until cleared', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', true)
    cache.setSummaryError('he2017drain', 'llm_quota')
    expect(cache.summaryError('he2017drain')).toBe('llm_quota')
    cache.setSummaryError('he2017drain', null)
    expect(cache.summaryError('he2017drain')).toBeNull()
  })

  it('rebuilds a v1 cache', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE papers (id TEXT PRIMARY KEY); PRAGMA user_version = 1')
    db.close()
    const cache = IndexCache.open(file)
    cache.upsertPaper(samplePaper(), 'h', false)
    expect(cache.getPaper('he2017drain')?.summary_status).toBe('none')
  })

  it('rebuilds a v2 cache (schema v3 adds summary_model)', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE papers (id TEXT PRIMARY KEY); PRAGMA user_version = 2')
    db.close()
    const cache = IndexCache.open(file)
    cache.upsertPaper(samplePaper(), 'h', false)
    expect(cache.getPaper('he2017drain')).toMatchObject({ summary_status: 'none', summary_model: null })
  })
})

describe('IndexCache jobs by type', () => {
  it('skips excluded job types, cancels a queued batch and finds active jobs', async () => {
    const { cache } = await openCache()
    const a = cache.insertJob(JSON.stringify({ type: 'summarize', paperId: 'p1', batchId: 'b1' }), 't')
    const b = cache.insertJob(JSON.stringify({ type: 'ingest_identifier', input: 'x' }), 't')
    cache.insertJob(JSON.stringify({ type: 'summarize', paperId: 'p2', batchId: 'b1' }), 't')
    expect(cache.nextQueuedJob(['summarize'])?.id).toBe(b)
    expect(cache.hasActiveJob('summarize', 'p1')).toBe(true)
    cache.updateJob(a, { state: 'running' }, 't')
    expect(cache.cancelQueuedBatch('b1', 't2')).toBe(1)
    expect(cache.getJob(a)?.state).toBe('running')
    expect(cache.hasActiveJob('summarize', 'p2')).toBe(false)
  })

  it("lists a paper's active jobs of a type and rewrites a job's spec", async () => {
    const { cache } = await openCache()
    const a = cache.insertJob(JSON.stringify({ type: 'summarize', paperId: 'p1' }), 't')
    cache.insertJob(JSON.stringify({ type: 'summarize', paperId: 'p2' }), 't')
    expect(cache.activeJobs('summarize', 'p1').map((j) => j.id)).toEqual([a])
    cache.updateJobSpec(a, JSON.stringify({ type: 'summarize', paperId: 'p1', force: true }), 't2')
    expect(cache.getJob(a)).toMatchObject({ spec: JSON.stringify({ type: 'summarize', paperId: 'p1', force: true }), updated_at: 't2' })
  })
})

describe('IndexCache v5: relations', () => {
  const citations: Citations = {
    source: 'openalex',
    fetched_at: '2026-10-09T12:00:00.000Z',
    openalex_id: 'W2754665629',
    references: ['W1', 'W2'],
    cited_by_count: 904
  }

  it('indexes citations from paper.yaml: status, OpenAlex id and edges', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper({ citations }), 'h', false)
    expect(cache.getPaper('he2017drain')?.citations_status).toBe('ok')
    expect(cache.citationEdges()).toEqual([
      { citing: 'he2017drain', cited: 'W1' },
      { citing: 'he2017drain', cited: 'W2' }
    ])
    expect(cache.relationRows()).toEqual([
      {
        id: 'he2017drain',
        title: samplePaper().title,
        year: 2017,
        doi: '10.1109/icws.2017.13',
        openalex_id: 'W2754665629',
        cited_by_count: 904,
        citations_status: 'ok',
        thesis_score: null
      }
    ])
    cache.upsertPaper(samplePaper({ citations: { source: 'openalex', fetched_at: 't', references: [], unresolved: true } }), 'h2', false)
    expect(cache.getPaper('he2017drain')?.citations_status).toBe('unresolved')
    expect(cache.citationEdges()).toEqual([])
  })

  it('stores incoming citations, external works, vectors, neighbours and facets, and forgets them with the paper', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', false)
    cache.setIncoming('he2017drain', ['W9', 'W8'], 't')
    expect(cache.incomingEdges()).toEqual([
      { paperId: 'he2017drain', citing: 'W8' },
      { paperId: 'he2017drain', citing: 'W9' }
    ])
    const work = { openalexId: 'W8', title: 'T', year: 2020, authors: 'A', doi: '10.1/x', citedByCount: 3 }
    cache.upsertExternalWorks([work], 't')
    expect(cache.externalWorks(['W8', 'W7'])).toEqual(new Map([['W8', work]]))
    cache.setVector('he2017drain', 'ih', 'm1', new Float32Array([0.5, 0.25]))
    expect(cache.vectorMeta('he2017drain')).toEqual({ inputHash: 'ih', model: 'm1' })
    expect([...cache.vectors('m1').get('he2017drain')!]).toEqual([0.5, 0.25])
    expect(cache.vectors('m2').size).toBe(0)
    cache.replaceSimilar([{ a: 'he2017drain', b: 'x', score: 0.5, reasons: [{ kind: 'coupling', shared: 2 }] }])
    expect(cache.similarFor('he2017drain')).toEqual([{ other: 'x', score: 0.5, reasons: [{ kind: 'coupling', shared: 2 }] }])
    expect(cache.allSimilar()).toHaveLength(1)
    cache.setSimilarRows(new Map([['he2017drain', [{ a: 'he2017drain', b: 'y', score: 0.7, reasons: [] }]], ['x', []]]))
    expect(cache.allSimilar().map((r) => [r.a, r.b])).toEqual([['he2017drain', 'y']])
    cache.setFacets('he2017drain', [{ facet: 'task', value: 'log_parsing', reviewed: true }], 4)
    expect(cache.facetRows()).toEqual([{ paperId: 'he2017drain', facet: 'task', value: 'log_parsing', reviewed: true, year: 2017 }])
    expect(cache.relationRows()[0].thesis_score).toBe(4)
    cache.removePaper('he2017drain')
    expect([cache.incomingEdges(), cache.vectors('m1').size, cache.similarFor('he2017drain'), cache.facetRows()]).toEqual([[], 0, [], []])
  })

  it('clears every vector', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', false)
    cache.setVector('he2017drain', 'ih', 'm1', new Float32Array([1]))
    cache.clearVectors()
    expect(cache.vectorMeta('he2017drain')).toBeNull()
  })

  it('cancels queued jobs by type and finds pending ones', async () => {
    const { cache } = await openCache()
    cache.insertJob(JSON.stringify({ type: 'citations', paperId: 'a' }), 't')
    const running = cache.insertJob(JSON.stringify({ type: 'embed', paperId: 'a' }), 't')
    cache.updateJob(running, { state: 'running' }, 't')
    cache.insertJob(JSON.stringify({ type: 'model_download' }), 't')
    expect(cache.hasQueuedJobs(['embed'])).toBe(false)
    expect(cache.hasQueuedJobs(['embed', 'citations'])).toBe(true)
    expect(cache.hasActiveJobOfType('model_download')).toBe(true)
    expect(cache.cancelQueuedTypes(['citations', 'cited_by'], 't2')).toBe(1)
    expect(cache.hasQueuedJobs(['citations'])).toBe(false)
  })

  it('rebuilds a v4 cache', async () => {
    const file = join(await tmpDir(), 'index.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE papers (id TEXT PRIMARY KEY); PRAGMA user_version = 4')
    db.close()
    const cache = IndexCache.open(file)
    cache.upsertPaper(samplePaper(), 'h', false)
    expect(cache.getPaper('he2017drain')?.citations_status).toBe('none')
  })
})

describe('IndexCache typed relations', () => {
  it('replaces and lists relations, all or those of one paper', async () => {
    const { cache } = await openCache()
    const a = typed('zhu2020loghub', 'he2017drain')
    const b = typed('am2019x', 'zz2020y', { status: 'confirmed' })
    cache.replaceTypedRelations([a, b])
    expect(cache.typedRelations()).toEqual([b, a])
    expect(cache.typedRelations('he2017drain')).toEqual([a])
    cache.replaceTypedRelations([b])
    expect(cache.typedRelations('he2017drain')).toEqual([])
  })

  it('counts the suggestions that touch each paper in its row', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', false)
    cache.upsertPaper(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' }), 'h', false)
    cache.replaceTypedRelations([typed('zhu2020loghub', 'he2017drain'), typed('am2019x', 'he2017drain', { status: 'rejected' })])
    expect(cache.getPaper('he2017drain')?.relations_pending).toBe(1)
    expect(cache.listPapers().map((r) => [r.id, r.relations_pending])).toEqual([
      ['he2017drain', 1],
      ['zhu2020loghub', 1]
    ])
  })

  it('searches chunks best match first, optionally within one paper', async () => {
    const { cache } = await openCache()
    cache.upsertPaper(samplePaper(), 'h', false)
    cache.upsertPaper(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' }), 'h', false)
    cache.setText('he2017drain', 't', 'ok', [
      { index: 0, page: 1, text: 'Drain parses logs with a fixed depth tree.' },
      { index: 1, page: 2, text: 'Evaluation on five datasets.' }
    ])
    cache.setText('zhu2020loghub', 't', 'ok', [{ index: 0, page: 3, text: 'We evaluate Drain and other parsers on Loghub.' }])
    expect(cache.searchChunks('drain', { limit: 10 }).map((h) => h.paperId).sort()).toEqual(['he2017drain', 'zhu2020loghub'])
    expect(cache.searchChunks('drain', { paperId: 'zhu2020loghub', limit: 10 })).toEqual([
      { paperId: 'zhu2020loghub', page: 3, text: 'We evaluate Drain and other parsers on Loghub.' }
    ])
    expect(cache.searchChunks('evaluation datasets', { limit: 1 })).toEqual([{ paperId: 'he2017drain', page: 2, text: 'Evaluation on five datasets.' }])
    expect(cache.searchChunks('  ', { limit: 5 })).toEqual([])
  })

  it('rebuilds a v6 index', async () => {
    const file = join(await tmpDir(), '.cache', 'index.sqlite')
    IndexCache.open(file).close()
    const db = new DatabaseSync(file)
    db.exec('PRAGMA user_version = 6')
    db.close()
    const cache = IndexCache.open(file)
    expect(cache.typedRelations()).toEqual([])
  })
})
