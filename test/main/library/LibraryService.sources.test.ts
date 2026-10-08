import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PdfjsExtractor } from '../../../src/main/extract/PdfExtractor'
import { DRAIN, LOGHUB_PREPRINT, setupLibrary } from '../../helpers/library'
import { makePdf } from '../../helpers/pdf'
import { tmpDir } from '../../helpers/tmp'

const html = (name: string): string => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8')
const BLOG = 'https://eng.acme.test/posts/database-outage'

async function pdfFile(pages: string[][], info: { title?: string; author?: string } = {}): Promise<string> {
  const path = join(await tmpDir(), 'dropped.pdf')
  await writeFile(path, await makePdf(pages, info))
  return path
}

describe('LibraryService.ingestPdf', () => {
  it('resolves a dropped PDF through the DOI printed on it and indexes its text', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const path = await pdfFile([['Drain', 'DOI: 10.1109/ICWS.2017.13'], ['Pseudonymization keeps referential integrity.']])
    expect(await library.ingestPdf(path)).toEqual({ status: 'added', paperId: 'he2017drain' })
    expect(existsSync(join(store.paperDir('he2017drain'), 'paper.pdf'))).toBe(true)
    expect(library.list('referential').map((r) => r.id)).toEqual(['he2017drain'])
  })

  it('keeps a PDF without identifiers as incomplete, titled from its metadata', async () => {
    const { store, library } = await setupLibrary()
    const path = await pdfFile([['Sanitizing logs with NER for incident reviews in production systems.']], { title: 'Sanitizing logs with NER', author: 'Ana Pérez' })
    const outcome = await library.ingestPdf(path)
    expect(outcome).toEqual({ status: 'added', paperId: 'anaperezndsanitizing' })
    const read = await store.readPaper(outcome.paperId)
    expect(read.ok && read.value).toMatchObject({ metadata_status: 'incomplete', title: 'Sanitizing logs with NER', kind: 'other' })
    expect(read.ok && read.value.bibtex).toContain('@misc{anaperezndsanitizing,')
  })

  it('keeps the DOI when resolution fails so metadata can be completed later', async () => {
    const { store, resolver, library } = await setupLibrary()
    const path = await pdfFile([['Drain: An Online Log Parsing Approach', 'DOI: 10.1109/ICWS.2017.13']])
    const { paperId } = await library.ingestPdf(path)
    const before = await store.readPaper(paperId)
    expect(before.ok && before.value).toMatchObject({ metadata_status: 'incomplete', identifiers: { doi: '10.1109/icws.2017.13' } })

    resolver.set('10.1109/icws.2017.13', DRAIN)
    expect(await library.updateMetadata(paperId)).toEqual({ status: 'merged', paperId })
    const after = await store.readPaper(paperId)
    expect(after.ok && after.value).toMatchObject({ id: paperId, metadata_status: 'complete', venue: 'ICWS' })
    expect(after.ok && after.value.bibtex.startsWith(`@inproceedings{${paperId},`)).toBe(true)
  })

  it('completes metadata from an identifier typed by the user', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const { paperId } = await library.ingestPdf(await pdfFile([['An untitled draft about log parsing trees.']]))
    await library.updateMetadata(paperId, 'https://doi.org/10.1109/ICWS.2017.13')
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value).toMatchObject({ id: paperId, title: DRAIN.title, metadata_status: 'complete' })
    await expect(library.updateMetadata(paperId, 'nonsense')).rejects.toMatchObject({ code: 'invalid_identifier' })
  })

  it('attaches a PDF to a paper added earlier by DOI', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')
    const outcome = await library.ingestPdf(await pdfFile([['Drain', 'DOI: 10.1109/ICWS.2017.13']]))
    expect(outcome).toEqual({ status: 'merged', paperId: 'he2017drain' })
    expect(store.resolvePdf('he2017drain')).not.toBeNull()
  })

  it('keeps a dropped PDF in the paper folder under download_on_demand when it cannot be downloaded again', async () => {
    const { store, library } = await setupLibrary({ policy: 'download_on_demand' })
    const { paperId } = await library.ingestPdf(await pdfFile([['Sanitizing logs with NER for incident reviews in production systems.']]))
    expect(store.resolvePdf(paperId)).toBe(join(store.paperDir(paperId), 'paper.pdf'))
  })

  it('extracts the text of a freshly ingested PDF only once', async () => {
    const pdfjs = new PdfjsExtractor()
    let extractions = 0
    const extractor = { extract: (data: Uint8Array) => (extractions++, pdfjs.extract(data)) }
    const { library } = await setupLibrary({ extractor })
    const { paperId } = await library.ingestPdf(await pdfFile([['Sanitizing logs with NER for incident reviews in production systems.']]))
    expect(extractions).toBe(1)
    expect(library.list('sanitizing').map((r) => r.id)).toEqual([paperId])
  })

  it('reports a corrupt PDF with a user-facing code', async () => {
    const { library } = await setupLibrary()
    const path = join(await tmpDir(), 'broken.pdf')
    await writeFile(path, '%PDF-1.7 garbage')
    await expect(library.ingestPdf(path)).rejects.toMatchObject({ code: 'unreadable_pdf' })
  })

  it('rejects files that are not PDFs', async () => {
    const { library } = await setupLibrary()
    const path = join(await tmpDir(), 'fake.pdf')
    await writeFile(path, 'hello')
    await expect(library.ingestPdf(path)).rejects.toMatchObject({ code: 'not_a_pdf' })
  })
})

describe('LibraryService URLs', () => {
  it('captures a blog post as grey literature with readable content', async () => {
    const { store, library } = await setupLibrary({ routes: [{ url: BLOG, body: html('postmortem.html'), headers: { 'content-type': 'text/html' } }] })
    const { paperId } = await library.ingestIdentifier(BLOG)
    expect(paperId).toBe('janeroe2024database')
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value).toMatchObject({ kind: 'web', identifiers: { url: BLOG } })
    expect(read.ok && read.value.bibtex).toContain('@online{janeroe2024database,')
    expect(await store.readContent(paperId)).toContain('## Timeline')
    expect(library.list('rollback').map((r) => r.id)).toEqual([paperId])
  })

  it('resolves a publisher landing page through its citation_doi', async () => {
    const { resolver, library } = await setupLibrary({
      resolver: { '10.1109/icws.2017.13': DRAIN },
      routes: [{ url: 'https://ieeexplore.ieee.test/document/1', body: html('scholarly.html') }]
    })
    expect(await library.ingestIdentifier('https://ieeexplore.ieee.test/document/1')).toEqual({ status: 'added', paperId: 'he2017drain' })
    expect(resolver.calls).toEqual(['10.1109/icws.2017.13'])
  })

  it('ingests a URL that serves a PDF', async () => {
    const pdf = await makePdf([['Drain', 'DOI: 10.1109/ICWS.2017.13']])
    const { library } = await setupLibrary({
      resolver: { '10.1109/icws.2017.13': DRAIN },
      routes: [{ url: 'https://files.acme.test/drain.pdf', body: pdf, headers: { 'content-type': 'application/pdf' } }]
    })
    expect(await library.ingestIdentifier('https://files.acme.test/drain.pdf')).toEqual({ status: 'added', paperId: 'he2017drain' })
  })

  it('keeps a PDF from a direct URL re-downloadable from that URL under download_on_demand', async () => {
    const pdf = await makePdf([['Sanitizing logs with NER for incident reviews in production systems.']])
    const { root, store, library } = await setupLibrary({
      policy: 'download_on_demand',
      routes: [{ url: 'https://files.acme.test/ner.pdf', body: pdf, headers: { 'content-type': 'application/pdf' } }]
    })
    const { paperId } = await library.ingestIdentifier('https://files.acme.test/ner.pdf')
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value.oa_pdf_url).toBe('https://files.acme.test/ner.pdf')
    expect(store.resolvePdf(paperId)).toBe(join(root, '.cache/pdfs', `${paperId}.pdf`))
  })

  it('reports pages without a readable article', async () => {
    const { library } = await setupLibrary({ routes: [{ url: 'https://x.acme.test/', body: '<html><body>hi</body></html>' }] })
    await expect(library.ingestIdentifier('https://x.acme.test/')).rejects.toMatchObject({ code: 'unreadable_page' })
  })
})

describe('LibraryService.readPdf', () => {
  it('downloads on demand into the cache under the download_on_demand policy', async () => {
    const pdf = await makePdf([['Loghub collects system logs for research on software reliability analysis.']])
    const { root, store, library } = await setupLibrary({
      policy: 'download_on_demand',
      resolver: { '10.48550/arxiv.2008.06448': LOGHUB_PREPRINT },
      routes: [{ url: 'https://arxiv.org/pdf/2008.06448', body: pdf }]
    })
    await library.ingestIdentifier('2008.06448')
    expect(store.resolvePdf('zhu2020loghub')).toBeNull()
    const bytes = await library.readPdf('zhu2020loghub')
    expect(bytes?.byteLength).toBe(pdf.byteLength)
    expect(existsSync(join(root, '.cache/pdfs/zhu2020loghub.pdf'))).toBe(true)
    const read = await store.readPaper('zhu2020loghub')
    expect(read.ok && read.value.pdf_sha256).toHaveLength(64)
    expect(library.list()[0].text_status).toBe('ok')
  })

  it('downloads once when the same PDF is opened twice at the same time', async () => {
    const pdf = await makePdf([['Loghub collects system logs for research on software reliability analysis.']])
    const { store, library, fetch } = await setupLibrary({
      policy: 'download_on_demand',
      resolver: { '10.48550/arxiv.2008.06448': LOGHUB_PREPRINT },
      routes: [{ url: 'https://arxiv.org/pdf/2008.06448', body: pdf }]
    })
    await library.ingestIdentifier('2008.06448')
    const [a, b] = await Promise.all([library.readPdf('zhu2020loghub'), library.readPdf('zhu2020loghub')])
    expect(a?.byteLength).toBe(pdf.byteLength)
    expect(b?.byteLength).toBe(pdf.byteLength)
    expect(fetch.calls.filter((c) => c.url === 'https://arxiv.org/pdf/2008.06448')).toHaveLength(1)
    const read = await store.readPaper('zhu2020loghub')
    expect(read.ok && read.value.pdf_sha256).toHaveLength(64)
  })

  it('still returns the downloaded PDF when paper.yaml changed meanwhile', async () => {
    const pdf = await makePdf([['Loghub collects system logs for research on software reliability analysis.']])
    const { store, library } = await setupLibrary({
      policy: 'download_on_demand',
      resolver: { '10.48550/arxiv.2008.06448': LOGHUB_PREPRINT },
      routes: [{ url: 'https://arxiv.org/pdf/2008.06448', body: pdf }]
    })
    await library.ingestIdentifier('2008.06448')
    const file = join(store.paperDir('zhu2020loghub'), 'paper.yaml')
    const original = store.writePdf.bind(store)
    store.writePdf = async (id, bytes, opts) => {
      await writeFile(file, (await readFile(file, 'utf8')).replace(/^title: .*$/m, 'title: Edited in another editor'))
      return original(id, bytes, opts)
    }
    expect((await library.readPdf('zhu2020loghub'))?.byteLength).toBe(pdf.byteLength)
  })

  it('returns null when there is no PDF anywhere', async () => {
    const { library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')
    expect(await library.readPdf('he2017drain')).toBeNull()
  })
})

describe('LibraryService notes', () => {
  it('reports conflicts instead of overwriting external edits', async () => {
    const { store, library } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestIdentifier('10.1109/icws.2017.13')
    const saved = await library.writeNotes('he2017drain', 'mine', null)
    expect(saved.ok).toBe(true)
    await writeFile(join(store.paperDir('he2017drain'), 'notes.md'), 'edited in another editor')
    expect(await library.writeNotes('he2017drain', 'mine again', saved.ok ? saved.hash : null)).toEqual({ ok: false, reason: 'conflict' })
    expect(await readFile(join(store.paperDir('he2017drain'), 'notes.md'), 'utf8')).toBe('edited in another editor')
    expect((await library.readNotes('he2017drain')).text).toBe('edited in another editor')
  })
})
