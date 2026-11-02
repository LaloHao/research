import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PdfjsExtractor, type PdfExtractor } from '../../../src/main/extract/PdfExtractor'
import type { TrashRelations } from '../../../src/main/library/LibraryService'
import type { PaperReferences } from '../../../src/main/library/paperReferences'
import { ProjectError } from '../../../src/main/project/errors'
import { setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'
import { makePdf } from '../../helpers/pdf'

const ID = 'he2017drain'
const NEW = 'he2017online'
const DEVICE = '22222222-2222-2222-2222-222222222222'

class CountingExtractor implements PdfExtractor {
  calls = 0
  private readonly inner = new PdfjsExtractor()
  extract(data: Uint8Array) {
    this.calls++
    return this.inner.extract(data)
  }
}

/** relations.yaml and the other references as calls, so the order and the undo can be checked. */
function fakes(over: { relations?: Partial<TrashRelations>; references?: PaperReferences['rekey'] } = {}) {
  const calls: string[] = []
  const relations: TrashRelations = {
    countTouching: async () => 0,
    removeTouching: async () => 0,
    rekey: async (from, to, o) => void calls.push(`relations:${from}>${to}${o?.keepAnalysis ? ' (analysis)' : ''}`),
    ...over.relations
  }
  const references: PaperReferences = {
    rekey:
      over.references ??
      (async (from, to) => {
        calls.push(`references:${from}>${to}`)
        return async () => void calls.push(`references back:${to}>${from}`)
      })
  }
  return { calls, relations, references }
}

/** Drain in the library with a real PDF, indexed. */
async function withDrain(over: Parameters<typeof fakes>[0] = {}) {
  const extractor = new CountingExtractor()
  const f = fakes(over)
  const lib = await setupLibrary({ extractor, deviceId: DEVICE, relations: f.relations, references: f.references })
  await lib.store.writePaper(samplePaper(), null)
  await writeFile(join(lib.store.paperDir(ID), 'paper.pdf'), await makePdf([['Drain parses logs with a fixed depth tree.']]))
  await writeFile(join(lib.store.paperDir(ID), 'notes.md'), 'My notes.')
  await lib.library.reindexAll()
  return { ...lib, extractor, calls: f.calls }
}

describe('LibraryService.suggestKey', () => {
  it('builds the key from the current metadata, like an ingest, and says when it is the key the paper has', async () => {
    const { library } = await withDrain()
    expect(await library.suggestKey(ID)).toEqual({ key: ID, same: true })
    await library.editMetadata(ID, { title: 'Online Log Parsing', year: 2016, authors: [{ family: 'Beyer', given: 'Betsy' }] })
    expect(await library.suggestKey(ID)).toEqual({ key: 'beyer2016online', same: false })
  })

  it('skips keys other papers use, in the library or the trash', async () => {
    const { library, store } = await withDrain()
    await library.editMetadata(ID, { year: 2016 })
    await store.writePaper(samplePaper({ id: 'he2016drain', title: 'Other' }), null)
    await mkdir(store.trashDir('he2016draina'), { recursive: true })
    expect(await library.suggestKey(ID)).toEqual({ key: 'he2016drainb', same: false })
  })

  it('takes a web page site when it has no authors', async () => {
    const { library, store } = await withDrain()
    await store.writePaper(samplePaper({ id: 'page', kind: 'web', authors: [], year: 2024, venue: 'Towards Data Science', title: 'How to Validate' }), null)
    expect(await library.suggestKey('page')).toEqual({ key: 'towardsdatascience2024validate', same: false })
  })
})

describe('LibraryService.changeKey', () => {
  it('moves the folder and rewrites paper.yaml, the BibTeX key, the index and library.bib, without extracting the PDF again', async () => {
    const { library, store, cache, root, extractor, calls } = await withDrain()
    const before = extractor.calls
    const text = { status: cache.getPaper(ID)?.text_status, hash: cache.textHash(ID) }
    let events = 0
    library.onChange(() => events++)
    expect(await library.changeKey(ID, ` ${NEW} `)).toBe(NEW)

    expect(existsSync(store.paperDir(ID))).toBe(false)
    expect(await readFile(join(store.paperDir(NEW), 'notes.md'), 'utf8')).toBe('My notes.')
    expect(existsSync(join(store.paperDir(NEW), 'paper.pdf'))).toBe(true)
    const read = await store.readPaper(NEW)
    expect(read.ok && read.value.id).toBe(NEW)
    expect(read.ok && read.value.bibtex).toMatch(/^@inproceedings\{he2017online,/)
    expect(read.ok && read.value.updated_at).toBe('2026-10-07T12:00:00.000Z')

    expect(library.list().map((r) => r.id)).toEqual([NEW])
    expect(library.list('fixed depth').map((r) => r.id)).toEqual([NEW])
    expect(cache.getPaper(ID)).toBeNull()
    expect(cache.chunksFor(ID)).toEqual([])
    expect({ status: cache.getPaper(NEW)?.text_status, hash: cache.textHash(NEW) }).toEqual(text)
    expect(extractor.calls).toBe(before)

    const bib = await readFile(join(root, 'exports/library.bib'), 'utf8')
    expect(bib).toContain(`{${NEW},`)
    expect(bib).not.toContain(ID)
    expect(calls).toEqual([`relations:${ID}>${NEW} (analysis)`, `references:${ID}>${NEW}`])
    expect(events).toBeGreaterThan(0)
    expect((await library.detail(NEW)).paper?.id).toBe(NEW)
  })

  it('moves the on-demand PDF in the cache with the paper', async () => {
    const lib = await setupLibrary({ policy: 'download_on_demand' })
    await lib.store.writePaper(samplePaper({ oa_pdf_url: 'https://example.org/drain.pdf' }), null)
    await mkdir(join(lib.store.cacheDir, 'pdfs'), { recursive: true })
    await writeFile(join(lib.store.cacheDir, 'pdfs', `${ID}.pdf`), await makePdf([['Drain.']]))
    await lib.library.reindexAll()
    await lib.library.changeKey(ID, NEW)
    expect(existsSync(join(lib.store.cacheDir, 'pdfs', `${ID}.pdf`))).toBe(false)
    expect(lib.store.resolvePdf(NEW)).toBe(join(lib.store.cacheDir, 'pdfs', `${NEW}.pdf`))
  })

  it('refuses a malformed key, the same key, a key in use and a paper with jobs, changing nothing', async () => {
    const { library, store, cache, calls } = await withDrain()
    await store.writePaper(samplePaper({ id: 'zhu2020loghub', title: 'Loghub' }), null)
    await mkdir(store.trashDir('trashed'), { recursive: true })
    await mkdir(store.paperDir('leftover'), { recursive: true })
    await expect(library.changeKey(ID, 'Beyer2016')).rejects.toMatchObject({ code: 'invalid_key' })
    await expect(library.changeKey(ID, '2016beyer')).rejects.toMatchObject({ code: 'invalid_key' })
    await expect(library.changeKey(ID, 'beyer-2016')).rejects.toMatchObject({ code: 'invalid_key' })
    await expect(library.changeKey(ID, '')).rejects.toMatchObject({ code: 'invalid_key' })
    await expect(library.changeKey(ID, ID)).rejects.toMatchObject({ code: 'key_unchanged' })
    await expect(library.changeKey(ID, 'zhu2020loghub')).rejects.toMatchObject({ code: 'key_taken' })
    await expect(library.changeKey(ID, 'trashed')).rejects.toMatchObject({ code: 'key_taken' })
    await expect(library.changeKey(ID, 'leftover')).rejects.toMatchObject({ code: 'key_taken' })
    await expect(library.changeKey('nosuchpaper', NEW)).rejects.toMatchObject({ code: 'paper_not_in_library' })
    cache.insertJob(JSON.stringify({ type: 'citations', paperId: ID }), '2026-10-07T12:00:00.000Z')
    await expect(library.changeKey(ID, NEW)).rejects.toMatchObject({ code: 'paper_busy' })
    expect(calls).toEqual([])
    expect(store.paperExists(ID)).toBe(true)
  })

  it('puts relations.yaml back when another reference cannot be rewritten', async () => {
    const { library, store, calls } = await withDrain({
      references: async () => {
        throw new ProjectError('chats in conflict', 'folder_busy')
      }
    })
    await expect(library.changeKey(ID, NEW)).rejects.toMatchObject({ code: 'folder_busy' })
    expect(calls).toEqual([`relations:${ID}>${NEW} (analysis)`, `relations:${NEW}>${ID} (analysis)`])
    expect(store.paperExists(ID)).toBe(true)
    expect(library.list().map((r) => r.id)).toEqual([ID])
  })

  it('touches nothing when relations.yaml refuses (a git conflict)', async () => {
    const { library, store, calls } = await withDrain({
      relations: {
        rekey: async () => {
          throw new ProjectError('conflict', 'trash_problem')
        }
      }
    })
    await expect(library.changeKey(ID, NEW)).rejects.toMatchObject({ code: 'trash_problem' })
    expect(calls).toEqual([])
    expect(store.paperExists(ID)).toBe(true)
  })

  it('undoes every reference and keeps paper.yaml as it was when the folder cannot move', async () => {
    const { library, store, calls } = await withDrain()
    const original = await readFile(join(store.paperDir(ID), 'paper.yaml'), 'utf8')
    const move = vi.spyOn(store as unknown as { move: (a: string, b: string) => Promise<void> }, 'move').mockRejectedValue(new ProjectError('busy', 'folder_busy'))
    await expect(library.changeKey(ID, NEW)).rejects.toMatchObject({ code: 'folder_busy' })
    move.mockRestore()
    expect(calls).toEqual([`relations:${ID}>${NEW} (analysis)`, `references:${ID}>${NEW}`, `references back:${NEW}>${ID}`, `relations:${NEW}>${ID} (analysis)`])
    expect(await readFile(join(store.paperDir(ID), 'paper.yaml'), 'utf8')).toBe(original)
    expect(existsSync(store.paperDir(NEW))).toBe(false)
    expect(library.list().map((r) => r.id)).toEqual([ID])
    // Nothing was left behind: the change can be made again.
    expect(await library.changeKey(ID, NEW)).toBe(NEW)
  })
})
