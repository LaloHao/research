import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IndexCache } from '../../../src/main/cache/IndexCache'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

async function openCache(): Promise<{ cache: IndexCache; file: string }> {
  const file = join(await tmpDir(), '.cache', 'index.sqlite')
  return { cache: IndexCache.open(file), file }
}

describe('IndexCache papers', () => {
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
