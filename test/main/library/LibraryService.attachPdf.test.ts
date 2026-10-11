import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PdfjsExtractor } from '../../../src/main/extract/PdfExtractor'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { runJob, type JobServices } from '../../../src/main/library/ProjectSession'
import { setupLibrary } from '../../helpers/library'
import { samplePaper } from '../../helpers/papers'
import { makePdf } from '../../helpers/pdf'
import { sampleSummary } from '../../helpers/summaries'
import { tmpDir } from '../../helpers/tmp'

async function pdfFile(lines: string[], name = 'attached.pdf'): Promise<string> {
  const path = join(await tmpDir(), name)
  await writeFile(path, await makePdf([lines]))
  return path
}

async function withPaper(opts: Parameters<typeof setupLibrary>[0] = {}) {
  const lib = await setupLibrary(opts)
  await lib.store.writePaper(samplePaper(), null)
  await lib.library.indexPaper('he2017drain')
  return lib
}

describe('LibraryService.attachPdf', () => {
  it('attaches a PDF to a paper that has none and indexes its text', async () => {
    const { store, cache, library } = await withPaper()
    expect(library.list('pseudonymization')).toEqual([])
    const path = await pdfFile(['Pseudonymization keeps referential integrity in production logs.'])
    let changes = 0
    library.onChange(() => changes++)

    expect(await library.attachPdf('he2017drain', path, { replace: false })).toEqual({ status: 'pdf_attached', paperId: 'he2017drain' })

    const bytes = new Uint8Array(await readFile(path))
    expect(store.resolvePdf('he2017drain')).toBe(join(store.paperDir('he2017drain'), 'paper.pdf'))
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value.pdf_sha256).toBe(sha256(bytes))
    expect(library.list('pseudonymization').map((r) => r.id)).toEqual(['he2017drain'])
    expect(cache.getPaper('he2017drain')).toMatchObject({ has_pdf: true, text_status: 'ok' })
    expect(changes).toBeGreaterThan(0)
  })

  it('changes nothing but the PDF hash in paper.yaml', async () => {
    const { store, library } = await withPaper()
    const before = await store.readPaper('he2017drain')
    await library.attachPdf('he2017drain', await pdfFile(['DOI: 10.5555/another.paper', 'A different title printed on the PDF']), { replace: false })
    const after = await store.readPaper('he2017drain')
    if (!before.ok || !after.ok) throw new Error('unreadable paper.yaml')
    const { pdf_sha256, updated_at: _a, ...rest } = after.value
    const { updated_at: _b, ...restBefore } = before.value
    expect(pdf_sha256).toBeTruthy()
    expect(rest).toEqual(restBefore)
  })

  it('refuses to overwrite an existing PDF unless asked to replace it', async () => {
    const { store, library } = await withPaper()
    await library.attachPdf('he2017drain', await pdfFile(['The first copy of the paper text.']), { replace: false })
    const first = await readFile(store.resolvePdf('he2017drain')!)
    await expect(library.attachPdf('he2017drain', await pdfFile(['A second copy with other text.']), { replace: false })).rejects.toMatchObject({
      code: 'pdf_exists'
    })
    expect(await readFile(store.resolvePdf('he2017drain')!)).toEqual(first)
  })

  it('replaces the PDF and the indexed text, leaving the summary alone', async () => {
    const { store, library } = await withPaper()
    await library.attachPdf('he2017drain', await pdfFile(['Pseudonymization keeps referential integrity.']), { replace: false })
    await store.writeSummary('he2017drain', sampleSummary(), 'Body.\n', null)
    const summaryBefore = await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')
    const second = await pdfFile(['Tokenization of identifiers keeps incident reviews readable for every on-call engineer.'])
    expect(await library.attachPdf('he2017drain', second, { replace: true })).toEqual({ status: 'pdf_attached', paperId: 'he2017drain' })
    const bytes = new Uint8Array(await readFile(second))
    expect(new Uint8Array(await readFile(store.resolvePdf('he2017drain')!))).toEqual(bytes)
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value.pdf_sha256).toBe(sha256(bytes))
    expect(library.list('pseudonymization')).toEqual([])
    expect(library.list('tokenization').map((r) => r.id)).toEqual(['he2017drain'])
    expect(await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toBe(summaryBefore)
  })

  it('keeps an attached PDF in the paper folder and drops the old cached copy under download_on_demand', async () => {
    const { store, library } = await setupLibrary({ policy: 'download_on_demand' })
    await store.writePaper(samplePaper({ oa_pdf_url: 'https://example.test/drain.pdf' }), null)
    await store.writePdf('he2017drain', await makePdf([['The old downloaded copy.']]), { redownloadable: true })
    const cached = join(store.cacheDir, 'pdfs', 'he2017drain.pdf')
    expect(existsSync(cached)).toBe(true)
    const path = await pdfFile(['The new copy.'])
    await library.attachPdf('he2017drain', path, { replace: true })
    expect(store.resolvePdf('he2017drain')).toBe(join(store.paperDir('he2017drain'), 'paper.pdf'))
    expect(new Uint8Array(await readFile(store.resolvePdf('he2017drain')!))).toEqual(new Uint8Array(await readFile(path)))
    expect(existsSync(cached)).toBe(false)
  })

  it('records the hash even when paper.yaml changes while the PDF is being read', async () => {
    const pdfjs = new PdfjsExtractor()
    let edit: (() => Promise<void>) | null = null
    const extractor = {
      extract: async (data: Uint8Array) => {
        await edit?.()
        return pdfjs.extract(data)
      }
    }
    const { store, library } = await withPaper({ extractor })
    edit = async () => {
      const read = await store.readPaper('he2017drain')
      if (read.ok) await store.writePaper({ ...read.value, venue: 'Edited meanwhile' }, read.hash)
    }
    const path = await pdfFile(['Pseudonymization keeps referential integrity in production logs.'])
    await library.attachPdf('he2017drain', path, { replace: false })
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value).toMatchObject({ venue: 'Edited meanwhile', pdf_sha256: sha256(new Uint8Array(await readFile(path))) })
    expect(library.list('pseudonymization').map((r) => r.id)).toEqual(['he2017drain'])
  })

  it('indexes the written PDF even when recording its hash fails', async () => {
    const { store, cache, library } = await withPaper()
    const writePaper = store.writePaper.bind(store)
    store.writePaper = async () => {
      throw new Error('disk full')
    }
    const path = await pdfFile(['Pseudonymization keeps referential integrity in production logs.'])
    await expect(library.attachPdf('he2017drain', path, { replace: false })).rejects.toBeTruthy()
    store.writePaper = writePaper
    expect(cache.getPaper('he2017drain')).toMatchObject({ has_pdf: true, text_status: 'ok' })
  })

  it('rejects a directory and a file over 200 MB, for attaching and for ingesting', async () => {
    const { library } = await withPaper()
    const dir = await tmpDir()
    await expect(library.attachPdf('he2017drain', dir, { replace: false })).rejects.toMatchObject({ code: 'not_a_pdf' })
    await expect(library.ingestPdf(dir)).rejects.toMatchObject({ code: 'not_a_pdf' })
    const big = join(await tmpDir(), 'big.pdf')
    await writeFile(big, '%PDF-1.7\n')
    await truncate(big, 200 * 1024 * 1024 + 1)
    await expect(library.attachPdf('he2017drain', big, { replace: false })).rejects.toMatchObject({ code: 'file_too_large' })
    await expect(library.ingestPdf(big)).rejects.toMatchObject({ code: 'file_too_large' })
  })

  it('extracts the attached PDF only once', async () => {
    const pdfjs = new PdfjsExtractor()
    let extractions = 0
    const extractor = { extract: (data: Uint8Array) => (extractions++, pdfjs.extract(data)) }
    const { library } = await withPaper({ extractor })
    await library.attachPdf('he2017drain', await pdfFile(['Sanitizing logs with NER for incident reviews.']), { replace: false })
    expect(extractions).toBe(1)
  })

  it('rejects a file that is not a PDF, writing nothing', async () => {
    const { store, library } = await withPaper()
    const path = join(await tmpDir(), 'fake.pdf')
    await writeFile(path, 'hello')
    await expect(library.attachPdf('he2017drain', path, { replace: false })).rejects.toMatchObject({ code: 'not_a_pdf' })
    expect(store.resolvePdf('he2017drain')).toBeNull()
  })

  it('rejects a corrupt PDF before writing it', async () => {
    const { store, library } = await withPaper()
    const path = join(await tmpDir(), 'broken.pdf')
    await writeFile(path, '%PDF-1.7 garbage')
    await expect(library.attachPdf('he2017drain', path, { replace: false })).rejects.toMatchObject({ code: 'unreadable_pdf' })
    expect(store.resolvePdf('he2017drain')).toBeNull()
  })

  it('reports a missing or unreadable paper as a file problem', async () => {
    const { store, library } = await setupLibrary()
    const path = await pdfFile(['Some text for the PDF.'])
    await expect(library.attachPdf('nobody2020missing', path, { replace: false })).rejects.toMatchObject({ code: 'file_problem' })
    await store.writePaper(samplePaper(), null)
    await writeFile(join(store.paperDir('he2017drain'), 'paper.yaml'), '<<<<<<< HEAD\nid: x\n')
    await expect(library.attachPdf('he2017drain', path, { replace: false })).rejects.toMatchObject({ code: 'file_problem' })
    expect(store.resolvePdf('he2017drain')).toBeNull()
  })

  it('writes nothing when the job was cancelled', async () => {
    const { store, library } = await withPaper()
    const controller = new AbortController()
    controller.abort()
    await expect(library.attachPdf('he2017drain', await pdfFile(['Text.']), { replace: false }, controller.signal)).rejects.toThrow()
    expect(store.resolvePdf('he2017drain')).toBeNull()
  })

  it('runs as an attach_pdf job', async () => {
    const { store, library } = await withPaper()
    const path = await pdfFile(['Pseudonymization keeps referential integrity.'])
    const services = { library } as unknown as JobServices
    const result = await runJob(services, { type: 'attach_pdf', paperId: 'he2017drain', path, replace: false }, new AbortController().signal)
    expect(result).toEqual({ paperId: 'he2017drain', message: 'pdf_attached' })
    expect(store.resolvePdf('he2017drain')).not.toBeNull()
  })
})
