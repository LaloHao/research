import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { IndexCache, type TrashRow } from '../../../src/main/cache/IndexCache'
import { relationId, type TypedRelation } from '../../../src/shared/typedRelations'
import { samplePaper } from '../../helpers/papers'
import { tmpDir } from '../../helpers/tmp'

const ID = 'he2017drain'
const open = async (): Promise<IndexCache> => IndexCache.open(join(await tmpDir(), 'index.sqlite'))
const row = (over: Partial<TrashRow> = {}): TrashRow => ({
  id: ID,
  title: samplePaper().title,
  authors_label: 'He & Zhu',
  year: 2017,
  doi: '10.1109/icws.2017.13',
  openalex_id: 'W2754665629',
  trashed_at: '2026-10-11T12:00:00.000Z',
  device: 'dev-1',
  problem: null,
  ...over
})
const relation = (from: string, to: string): TypedRelation => ({
  id: relationId(from, to, 'extends'),
  type: 'extends',
  from,
  to,
  status: 'suggested',
  edited: false,
  justification: 'j',
  evidence: [],
  updated_at: '2026-10-10T00:00:00.000Z'
})

function seed(cache: IndexCache): void {
  cache.upsertPaper(samplePaper(), 'h', true)
  cache.setText(ID, 't1', 'ok', [{ index: 0, page: 1, text: 'Drain parses logs with a fixed depth tree.' }])
  cache.setVector(ID, 'in', 'm', new Float32Array([1, 0]))
}

describe('IndexCache trash', () => {
  it('takes a trashed paper out of every library read but keeps its text and vector for a restore', async () => {
    const cache = await open()
    seed(cache)
    cache.moveToTrash(row())
    expect(cache.listPapers()).toEqual([])
    expect(cache.getPaper(ID)).toBeNull()
    expect(cache.search('fixed depth')).toEqual([])
    expect(cache.searchChunks('fixed depth', { limit: 5 })).toEqual([])
    expect(cache.relationRows()).toEqual([])
    expect(cache.dedupeEntries()).toEqual([])
    expect(cache.trashEntries()).toEqual([row()])
    expect(cache.isTrashed(ID)).toBe(true)
    expect([...cache.trashedIds()]).toEqual([ID])
    // The watcher then sees the folder go: the kept text survives.
    cache.removePaper(ID)
    expect(cache.vectors('m').has(ID)).toBe(true)
    expect(cache.chunksFor(ID)).toHaveLength(1)
  })

  it('brings the text state back on restore, so the same PDF is not extracted again', async () => {
    const cache = await open()
    seed(cache)
    const chars = cache.textChars(ID)
    cache.moveToTrash(row())
    cache.takeFromTrash(ID)
    expect(cache.trashEntries()).toEqual([])
    expect(cache.textHash(ID)).toBe('t1')
    expect(cache.textChars(ID)).toBe(chars)
    cache.upsertPaper(samplePaper(), 'h', true)
    expect(cache.getPaper(ID)).toMatchObject({ text_status: 'ok', title: samplePaper().title })
    expect(cache.search('fixed depth')).toEqual([ID])
  })

  it('hides typed relations with an end in the trash, and their pending count', async () => {
    const cache = await open()
    cache.upsertPaper(samplePaper(), 'h', false)
    cache.upsertPaper(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' }), 'h', false)
    cache.replaceTypedRelations([relation('zhu2020loghub', ID)])
    expect(cache.getPaper('zhu2020loghub')?.relations_pending).toBe(1)
    cache.moveToTrash(row())
    expect(cache.typedRelations()).toEqual([])
    expect(cache.typedRelations('zhu2020loghub')).toEqual([])
    expect(cache.getPaper('zhu2020loghub')?.relations_pending).toBe(0)
    cache.takeFromTrash(ID)
    expect(cache.typedRelations()).toHaveLength(1)
  })

  it('treats a key that is both in the trash and in the library (a restore that left a remnant) as not trashed', async () => {
    const cache = await open()
    seed(cache)
    cache.upsertPaper(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' }), 'h', false)
    cache.replaceTypedRelations([relation('zhu2020loghub', ID)])
    cache.moveToTrash(row())
    // A remnant stays in .trash/<key>/ after the paper came back under the same key.
    cache.replaceTrash([row({ problem: 'missing_paper_yaml' })])
    cache.upsertPaper(samplePaper(), 'h', true)
    expect(cache.isTrashed(ID)).toBe(false)
    expect([...cache.trashedIds()]).toEqual([])
    expect(cache.typedRelations(ID)).toHaveLength(1)
    expect(cache.getPaper('zhu2020loghub')?.relations_pending).toBe(1)
    expect(cache.getPaper(ID)?.relations_pending).toBe(1)
    expect(cache.trashEntries().map((e) => e.id)).toEqual([ID])
    // The library paper leaves again: the remnant's trash row still keeps the text.
    cache.removePaper(ID)
    expect(cache.isTrashed(ID)).toBe(true)
    expect(cache.chunksFor(ID)).toHaveLength(1)
  })

  it('mirrors .trash/ keeping the text of listed entries and dropping text nobody owns', async () => {
    const cache = await open()
    seed(cache)
    cache.moveToTrash(row())
    const renamed = row({ title: 'Renamed', trashed_at: null, device: null })
    cache.replaceTrash([renamed])
    expect(cache.trashEntries()).toEqual([renamed])
    expect(cache.chunksFor(ID)).toHaveLength(1)
    cache.replaceTrash([])
    expect(cache.trashEntries()).toEqual([])
    expect(cache.chunksFor(ID)).toEqual([])
    expect(cache.vectors('m').has(ID)).toBe(false)
  })

  it('deletes an entry for good without touching a library paper that now has the same key', async () => {
    const cache = await open()
    seed(cache)
    cache.moveToTrash(row())
    cache.removeTrash(ID)
    expect(cache.chunksFor(ID)).toEqual([])
    seed(cache)
    cache.moveToTrash(row())
    cache.upsertPaper(samplePaper(), 'h2', false)
    cache.removeTrash(ID)
    expect(cache.getPaper(ID)).not.toBeNull()
    expect(cache.chunksFor(ID)).toHaveLength(1)
  })

  it('forgets the kept text state once a library paper takes the key', async () => {
    const cache = await open()
    seed(cache)
    cache.moveToTrash(row())
    cache.upsertPaper(samplePaper({ title: 'Another paper' }), 'h2', true)
    cache.setText(ID, 't2', 'ok', [{ index: 0, page: 1, text: 'A different text.' }])
    cache.removePaper(ID)
    cache.takeFromTrash(ID)
    // Its chunks are the other paper's now: the restored PDF must be extracted again.
    expect(cache.textHash(ID)).toBeNull()
  })

  it('takes the text state of a paper that git moved to the trash while the app was closed', async () => {
    const cache = await open()
    seed(cache)
    cache.replaceTrash([row()])
    cache.removePaper(ID)
    cache.takeFromTrash(ID)
    expect(cache.textHash(ID)).toBe('t1')
    expect(cache.chunksFor(ID)).toHaveLength(1)
  })

  it('cancels only the queued jobs of the given papers', async () => {
    const cache = await open()
    const a = cache.insertJob(JSON.stringify({ type: 'summarize', paperId: ID }), 'now')
    const b = cache.insertJob(JSON.stringify({ type: 'citations', paperId: 'zhu2020loghub' }), 'now')
    const c = cache.insertJob(JSON.stringify({ type: 'ingest_identifier', input: 'x' }), 'now')
    expect(cache.cancelQueuedPapers([ID], 'later')).toBe(1)
    expect([a, b, c].map((id) => cache.getJob(id)?.state)).toEqual(['cancelled', 'queued', 'queued'])
    expect(cache.cancelQueuedPapers([], 'later')).toBe(0)
  })
})
