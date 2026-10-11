import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PdfjsExtractor, type PdfExtractor } from '../../../src/main/extract/PdfExtractor'
import type { TrashRelations } from '../../../src/main/library/LibraryService'
import { UserFacingError } from '../../../src/main/library/UserFacingError'
import { DRAIN, setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'
import { makePdf } from '../../helpers/pdf'
import { sampleSummary } from '../../helpers/summaries'

const DEVICE = '22222222-2222-2222-2222-222222222222'
const ID = 'he2017drain'
const AT = '2026-10-07T12:00:00.000Z'

class CountingExtractor implements PdfExtractor {
  calls = 0
  private readonly inner = new PdfjsExtractor()
  extract(data: Uint8Array) {
    this.calls++
    return this.inner.extract(data)
  }
}

function fakeRelations(over: Partial<TrashRelations> = {}): { relations: TrashRelations; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    relations: {
      countTouching: async (ids) => {
        calls.push(`count:${ids.join(',')}`)
        return 2
      },
      removeTouching: async (ids) => {
        calls.push(`remove:${ids.join(',')}`)
        return 2
      },
      rekey: async (from, to) => {
        calls.push(`rekey:${from}>${to}`)
      },
      ...over
    }
  }
}

/** Drain in the library with a real PDF, indexed. */
async function withDrain(over: { relations?: TrashRelations } = {}) {
  const extractor = new CountingExtractor()
  const cancelled: string[][] = []
  const queuedCancelled: string[][] = []
  const fake = fakeRelations()
  const lib = await setupLibrary({
    extractor,
    deviceId: DEVICE,
    cancelJobs: async (ids) => void cancelled.push(ids),
    cancelQueued: (ids) => void queuedCancelled.push(ids),
    relations: over.relations ?? fake.relations,
    resolver: { '10.1109/icws.2017.13': DRAIN }
  })
  await lib.store.writePaper(samplePaper(), null)
  await writeFile(join(lib.store.paperDir(ID), 'paper.pdf'), await makePdf([['Drain parses logs with a fixed depth tree.']]))
  await lib.library.reindexAll()
  return { ...lib, extractor, cancelled, queuedCancelled, fake }
}

describe('LibraryService trash', () => {
  it('cancels the paper jobs, then moves it to the trash: gone from the list, the search and the bibliography', async () => {
    const { library, store, cancelled, queuedCancelled, root } = await withDrain()
    expect(await library.trash([ID, ID])).toEqual({ moved: [ID], error: null })
    expect(cancelled).toEqual([[ID]])
    expect(queuedCancelled).toEqual([[ID]])
    expect(store.trashExists(ID)).toBe(true)
    expect(library.list()).toEqual([])
    expect(library.list('fixed depth')).toEqual([])
    expect(await readFile(join(root, 'exports/library.bib'), 'utf8')).not.toContain(ID)
    expect(await library.listTrash()).toEqual([
      { id: ID, title: samplePaper().title, authors_label: 'He & Zhu', year: 2017, trashed_at: AT, device: DEVICE, this_device: true, problem: null }
    ])
  })

  it('leaves a paper in the library when its folder cannot move', async () => {
    const { library, store } = await withDrain()
    await mkdir(store.trashDir(ID), { recursive: true })
    expect(await library.trash([ID])).toEqual({ moved: [], error: 'trash_problem' })
    expect(library.list().map((r) => r.id)).toEqual([ID])
    expect(store.paperExists(ID)).toBe(true)
  })

  it('restores a paper as it was, without extracting its PDF again', async () => {
    const { library, extractor, root } = await withDrain()
    const before = extractor.calls
    await library.trash([ID])
    expect(await library.restore([ID], { merge: false })).toEqual({ restored: [{ id: ID, key: ID }], conflicts: [], failed: [] })
    expect(library.list().map((r) => r.id)).toEqual([ID])
    expect(library.list('fixed depth').map((r) => r.id)).toEqual([ID])
    expect(await library.listTrash()).toEqual([])
    expect(extractor.calls).toBe(before)
    expect(await readFile(join(root, 'exports/library.bib'), 'utf8')).toContain(ID)
  })

  it('re-reads .trash/ on every listing, so a trashed.yaml that arrives late shows its date', async () => {
    const { library, store } = await withDrain()
    await library.trash([ID])
    const file = join(store.trashDir(ID), 'trashed.yaml')
    const saved = await readFile(file, 'utf8')
    await rm(file)
    expect((await library.listTrash())[0].trashed_at).toBeNull()
    await writeFile(file, saved)
    expect((await library.listTrash())[0].trashed_at).toBe(AT)
  })

  it('offers to merge the same paper added again under its key: the more reviewed summary, both notes, every differing file kept', async () => {
    const { library, store, fake } = await withDrain()
    await store.writeNotes(ID, 'old notes', null)
    await store.writeSummary(ID, sampleSummary({ tldr: { value: 't', status: 'verified', evidence: [] } }), 'Body.\n', null)
    const trashedPdf = new Uint8Array(await readFile(join(store.paperDir(ID), 'paper.pdf')))
    await library.trash([ID])
    await store.writePaper(samplePaper(), null)
    await store.writeNotes(ID, 'new notes', null)
    await store.writeSummary(ID, sampleSummary(), 'Body.\n', null)
    const libraryPdf = await makePdf([['A different copy of Drain.']])
    await writeFile(join(store.paperDir(ID), 'paper.pdf'), libraryPdf)
    await library.indexPaper(ID)

    expect(await library.restore([ID], { merge: false })).toEqual({ restored: [], conflicts: [{ id: ID, title: samplePaper().title, target: ID }], failed: [] })
    expect(store.trashExists(ID)).toBe(true)

    expect(await library.restore([ID], { merge: true })).toEqual({ restored: [{ id: ID, key: ID }], conflicts: [], failed: [] })
    expect(store.trashExists(ID)).toBe(false)
    expect(await library.listTrash()).toEqual([])
    const summary = await store.readSummary(ID)
    expect(summary?.ok && summary.value.fields.tldr.status).toBe('verified')
    expect(existsSync(join(store.paperDir(ID), 'summary.before-merge.md'))).toBe(true)
    expect((await store.readNotes(ID)).text).toBe(`new notes\n\n<!-- notes of ${ID}, merged from the trash -->\nold notes`)
    expect(new Uint8Array(await readFile(join(store.paperDir(ID), 'paper.pdf')))).toEqual(libraryPdf)
    expect(new Uint8Array(await readFile(join(store.paperDir(ID), 'paper.trashed.pdf')))).toEqual(trashedPdf)
    // Same key: the relations already point at it.
    expect(fake.calls).toEqual([])
  })

  it('restores under a free key when a different paper took its key, and moves its relations there', async () => {
    const { library, store, fake } = await withDrain()
    await library.trash([ID])
    await store.writePaper(samplePaper({ title: 'A different paper about something else entirely', identifiers: { doi: '10.5555/other' } }), null)
    await library.indexPaper(ID)
    expect(await library.restore([ID], { merge: false })).toEqual({ restored: [{ id: ID, key: 'he2017draina' }], conflicts: [], failed: [] })
    expect(fake.calls).toEqual([`rekey:${ID}>he2017draina`])
    const read = await store.readPaper('he2017draina')
    expect(read.ok && read.value.title).toBe(samplePaper().title)
    expect(read.ok && read.value.bibtex).toContain('he2017draina')
    expect(store.resolvePdf('he2017draina')).not.toBeNull()
    expect(library.list().map((r) => r.id).sort()).toEqual([ID, 'he2017draina'])
    expect(store.trashExists(ID)).toBe(false)
  })

  it('keeps a trashed key reserved, finds the paper added again under another key and merges into it only on request', async () => {
    const { library, store, fake } = await withDrain()
    await library.trash([ID])
    expect((await library.ingestIdentifier('10.1109/icws.2017.13')).paperId).toBe('he2017draina')
    const first = await library.restore([ID], { merge: false })
    expect(first.conflicts).toEqual([{ id: ID, title: samplePaper().title, target: 'he2017draina' }])
    expect(fake.calls).toEqual([])
    expect(await library.restore([ID], { merge: true })).toEqual({ restored: [{ id: ID, key: 'he2017draina' }], conflicts: [], failed: [] })
    expect(fake.calls).toEqual([`rekey:${ID}>he2017draina`])
    expect(store.trashExists(ID)).toBe(false)
    expect(store.resolvePdf('he2017draina')).not.toBeNull()
    expect(library.list().map((r) => r.id)).toEqual(['he2017draina'])
  })

  it('restores into a folder a sync left behind and reports a subfolder that stayed in the trash', async () => {
    const { library, store } = await withDrain()
    await library.trash([ID])
    await mkdir(join(store.trashDir(ID), 'figures'), { recursive: true })
    await writeFile(join(store.trashDir(ID), 'figures', 'a.png'), 'x')
    await mkdir(store.paperDir(ID), { recursive: true })
    expect(await library.restore([ID], { merge: false })).toEqual({ restored: [{ id: ID, key: ID, remnant: true }], conflicts: [], failed: [] })
    expect(library.list().map((r) => r.id)).toEqual([ID])
    expect(await library.listTrash()).toEqual([expect.objectContaining({ id: ID, problem: 'missing_paper_yaml', trashed_at: AT })])
  })

  it('reports a merge that left a subfolder in the trash', async () => {
    const { library, store } = await withDrain()
    await library.trash([ID])
    await mkdir(join(store.trashDir(ID), 'figures'), { recursive: true })
    await writeFile(join(store.trashDir(ID), 'figures', 'a.png'), 'x')
    await store.writePaper(samplePaper(), null)
    await library.indexPaper(ID)
    expect(await library.restore([ID], { merge: true })).toEqual({ restored: [{ id: ID, key: ID, remnant: true }], conflicts: [], failed: [] })
    expect(store.trashExists(ID)).toBe(true)
    expect(await library.listTrash()).toEqual([expect.objectContaining({ id: ID, problem: 'missing_paper_yaml' })])
  })

  it('reports an undo of a paper that is no longer in the trash with its own code', async () => {
    const { library } = await withDrain()
    await library.trash([ID])
    await library.restore([ID], { merge: false })
    expect(await library.restore([ID], { merge: false })).toEqual({ restored: [], conflicts: [], failed: [{ id: ID, error: 'not_in_trash' }] })
  })

  it('«Vaciar papelera» deletes exactly the papers its confirmation counted, after their relations', async () => {
    const { library, store, fake } = await withDrain()
    await library.trash([ID])
    const plan = await library.deletePlan('all')
    expect(plan).toEqual({ ids: [ID], papers: 1, relations: 2 })
    expect(await library.deleteForever([...plan.ids, 'nothere'])).toBe(1)
    expect(fake.calls).toEqual([`count:${ID}`, `remove:${ID}`])
    expect(store.trashExists(ID)).toBe(false)
    expect(await library.listTrash()).toEqual([])
    expect(await library.deletePlan('all')).toEqual({ ids: [], papers: 0, relations: 0 })
  })

  it('deletes nothing when relations.yaml refuses the write', async () => {
    const refusing = fakeRelations({
      removeTouching: async () => {
        throw new UserFacingError('relations_conflict')
      }
    })
    const { library, store } = await withDrain({ relations: refusing.relations })
    await library.trash([ID])
    await expect(library.deleteForever([ID])).rejects.toThrow('relations_conflict')
    expect(store.trashExists(ID)).toBe(true)
    expect(await library.listTrash()).toHaveLength(1)
  })

  it('refuses to delete for good without the relations service', async () => {
    const lib = await setupLibrary({ deviceId: DEVICE })
    await lib.store.writePaper(samplePaper(), null)
    await lib.library.reindexAll()
    await lib.library.trash([ID])
    await expect(lib.library.deleteForever([ID])).rejects.toThrow('relations service')
    expect(lib.store.trashExists(ID)).toBe(true)
  })

  it('lists a trash folder without paper.yaml with its problem and refuses to restore it', async () => {
    const { library, store } = await withDrain()
    await mkdir(store.trashDir('broken'), { recursive: true })
    await writeFile(join(store.trashDir('broken'), 'notes.md'), 'x')
    expect(await library.listTrash()).toEqual([
      expect.objectContaining({ id: 'broken', title: 'broken', problem: 'missing_paper_yaml', trashed_at: null, this_device: false })
    ])
    expect(await library.restore(['broken'], { merge: false })).toEqual({ restored: [], conflicts: [], failed: [{ id: 'broken', error: 'trash_problem' }] })
  })
})
