import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256 } from '../../../src/main/project/atomicWrite'
import { bibFields } from '../../../src/shared/writing/bibtex'
import { DRAIN, setupLibrary } from '../../helpers/library'
import { sampleSummary } from '../../helpers/summaries'
import { makePdf } from '../../helpers/pdf'

const html = (name: string): string => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8')
const BLOCKED = 'https://towardsdatascience.com/how-to-validate-openai-gpt-model-performance-with-text-summarization-298978fea764/'
const BLOG = 'https://eng.acme.test/posts/database-outage'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('LibraryService: pages that refuse the app', () => {
  it('reports a plain 403 from a web page as a blocked site, never as an OpenAlex key problem', async () => {
    const { library, store } = await setupLibrary({ routes: [{ url: BLOCKED, status: 403, body: 'Forbidden', headers: { 'content-type': 'text/html' } }] })
    await expect(library.ingestIdentifier(BLOCKED)).rejects.toMatchObject({ code: 'site_blocked', message: 'site_blocked: HTTP 403' })
    expect(await store.listPaperIds()).toEqual([])
  })

  it('reports a Cloudflare challenge after one request', async () => {
    const { library, fetch } = await setupLibrary({
      routes: [{ url: BLOCKED, status: 503, body: '<title>Just a moment...</title>', headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' } }]
    })
    await expect(library.ingestIdentifier(BLOCKED)).rejects.toMatchObject({ code: 'site_blocked' })
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('LibraryService.ingestCapture', () => {
  it('adds a page from the app browser as a web page with its text and the printed PDF', async () => {
    const pdf = await makePdf([['Postmortem of the database outage: the rollback took forty minutes.']])
    const { library, store } = await setupLibrary()
    const outcome = await library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf })
    expect(outcome).toEqual({ status: 'added', paperId: 'roe2024database' })
    const read = await store.readPaper(outcome.paperId)
    expect(read.ok && read.value).toMatchObject({ kind: 'web', identifiers: { url: BLOG }, metadata_status: 'complete' })
    expect(read.ok && read.value.pdf_sha256).toHaveLength(64)
    expect(store.resolvePdf(outcome.paperId)).toBe(join(store.paperDir(outcome.paperId), 'paper.pdf'))
    expect(await store.readContent(outcome.paperId)).toContain('## Timeline')
    expect(library.list('forty').map((r) => r.id)).toEqual([outcome.paperId])
    // Adding the same page again finds it.
    expect((await library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf })).status).toBe('duplicate')
  })

  it('takes the DOI path when the page names a DOI, with the printed PDF attached', async () => {
    const pdf = await makePdf([['Drain parses logs online with a fixed depth tree.']])
    const { library, resolver, store } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    const outcome = await library.ingestCapture({ url: 'https://ieeexplore.ieee.test/document/1', html: html('scholarly.html'), pdf })
    expect(outcome).toEqual({ status: 'added', paperId: 'he2017drain' })
    expect(resolver.calls).toEqual(['10.1109/icws.2017.13'])
    expect(store.resolvePdf('he2017drain')).not.toBeNull()
    expect(await store.readContent('he2017drain')).toBeNull()
  })

  it('keeps a page without a readable article under its own title, incomplete, with the PDF', async () => {
    const pdf = await makePdf([['How to validate GPT models with text summarization and ROUGE scores.']])
    const { library, store } = await setupLibrary()
    const page = '<html><head><title>How to Validate OpenAI GPT Model Performance | Towards Data Science</title></head><body><div id="app"></div></body></html>'
    const { paperId } = await library.ingestCapture({ url: BLOCKED, html: page, pdf })
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value).toMatchObject({
      kind: 'web',
      title: 'How to Validate OpenAI GPT Model Performance',
      venue: 'towardsdatascience.com',
      metadata_status: 'incomplete'
    })
    expect(read.ok && read.value.bibtex).toContain('organization = {towardsdatascience.com}')
    expect(store.resolvePdf(paperId)).not.toBeNull()
    expect(library.list('rouge').map((r) => r.id)).toEqual([paperId])
  })

  it('reports an unreadable printed PDF without writing anything', async () => {
    const { library, store } = await setupLibrary()
    await expect(library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf: new TextEncoder().encode('%PDF-1.7 garbage') })).rejects.toMatchObject({
      code: 'unreadable_pdf'
    })
    expect(await store.listPaperIds()).toEqual([])
  })
})

describe('LibraryService: capturing a page that is already in the library', () => {
  it('finds the paper by its URL, normalized, and replaces its PDF keeping the summary', async () => {
    const first = await makePdf([['The banner said We value your privacy. Accept All.']])
    const { library, store } = await setupLibrary()
    const { paperId } = await library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf: first })
    await store.writeSummary(paperId, sampleSummary(), 'Kept.\n', null)
    const summaryBefore = await readFile(join(store.paperDir(paperId), 'summary.md'), 'utf8')
    expect(library.list('privacy').map((r) => r.id)).toEqual([paperId])

    for (const same of [BLOG, `${BLOG}/`, 'http://www.eng.acme.test/posts/database-outage?utm_source=x#timeline']) expect(await library.findByUrl(same)).toBe(paperId)
    for (const other of ['https://eng.acme.test/posts/other', 'https://eng.acme.test/posts/database-outage?page=2', 'not a url']) expect(await library.findByUrl(other)).toBeNull()

    const fixed = await makePdf([['Postmortem of the database outage: the rollback took forty minutes.']])
    expect(await library.replaceCapturedPdf(paperId, fixed)).toEqual({ status: 'pdf_attached', paperId })
    expect(await store.listPaperIds()).toEqual([paperId])
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value.pdf_sha256).toBe(sha256(fixed))
    expect(await readFile(join(store.paperDir(paperId), 'summary.md'), 'utf8')).toBe(summaryBefore)
    // The index has the new text, not the banner.
    expect(library.list('forty').map((r) => r.id)).toEqual([paperId])
    expect(library.list('privacy')).toEqual([])
  })

  it('refuses bytes that are not a PDF, leaving the paper as it was', async () => {
    const pdf = await makePdf([['Postmortem of the database outage.']])
    const { library, store } = await setupLibrary()
    const { paperId } = await library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf })
    await expect(library.replaceCapturedPdf(paperId, new TextEncoder().encode('<html>'))).rejects.toMatchObject({ code: 'not_a_pdf' })
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value.pdf_sha256).toBe(sha256(pdf))
  })
})

describe('LibraryService: «Volver a capturar desde la web»', () => {
  it('replaces the PDF of a paper found by its DOI, keeping its summary', async () => {
    const first = await makePdf([['Drain parses logs online. Cookie banner text.']])
    const { library, store } = await setupLibrary({ resolver: { '10.1109/icws.2017.13': DRAIN } })
    await library.ingestCapture({ url: 'https://ieeexplore.ieee.test/document/1', html: html('scholarly.html'), pdf: first })
    await store.writeSummary('he2017drain', sampleSummary(), 'Kept.\n', null)
    const summaryBefore = await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')
    const again = await makePdf([['Drain parses logs online with a fixed depth tree.']])
    expect(await library.replaceCapturedPdf('he2017drain', again)).toEqual({ status: 'pdf_attached', paperId: 'he2017drain' })
    const read = await store.readPaper('he2017drain')
    expect(read.ok && read.value.pdf_sha256).toBe(sha256(again))
    expect(read.ok && read.value.identifiers.doi).toBe('10.1109/icws.2017.13')
    expect(await readFile(join(store.paperDir('he2017drain'), 'summary.md'), 'utf8')).toBe(summaryBefore)
  })

  it('gives a web page saved without a PDF its first one', async () => {
    const { library, store } = await setupLibrary()
    const { paperId } = await library.ingestCapture({ url: BLOG, html: html('postmortem.html'), pdf: null })
    expect(store.resolvePdf(paperId)).toBeNull()
    const pdf = await makePdf([['Postmortem of the database outage: the rollback took forty minutes.']])
    await library.replaceCapturedPdf(paperId, pdf)
    expect(store.resolvePdf(paperId)).not.toBeNull()
    expect(await store.readContent(paperId)).toContain('## Timeline')
  })
})

describe('LibraryService.editMetadata', () => {
  async function webPaper() {
    const lib = await setupLibrary()
    const page = '<html><head><title>Why logs matter</title></head><body></body></html>'
    const { paperId } = await lib.library.ingestCapture({ url: 'https://acme.test/why-logs-matter', html: page, pdf: null })
    return { ...lib, paperId }
  }

  it('writes paper.yaml and its BibTeX entry, regenerates library.bib, and keeps the key', async () => {
    const { library, store, root, paperId } = await webPaper()
    const token = await library.editMetadata(paperId, { title: 'Why Logs Matter', authors: [{ family: 'Roe', given: 'Jane' }], date: '2024-05-02', venue: 'Acme Blog' })
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value).toMatchObject({ id: paperId, title: 'Why Logs Matter', year: 2024, venue: 'Acme Blog', metadata_status: 'complete' })
    const bib = await readFile(join(root, 'exports/library.bib'), 'utf8')
    expect(bib).toContain(`@online{${paperId},`)
    expect(bib).toContain('author = {Roe, Jane}')
    expect(bib).toContain('date = {2024-05-02}')
    expect(bib).toContain('organization = {Acme Blog}')
    expect(library.list('matter').map((r) => r.id)).toEqual([paperId])
  })

  it('undoes an edit while paper.yaml is still what it wrote', async () => {
    const { library, store, root, paperId } = await webPaper()
    const before = await store.readPaper(paperId)
    const token = await library.editMetadata(paperId, { title: 'Edited title' })
    await library.revertMetadata(token!)
    const after = await store.readPaper(paperId)
    expect(after.ok && after.value.title).toBe(before.ok && before.value.title)
    expect(after.ok && after.value.bibtex).toBe(before.ok && before.value.bibtex)
    expect(bibFields((await readFile(join(root, 'exports/library.bib'), 'utf8')).split('\n\n')[1]).get('title')).toBe('Why logs matter')
    // Spent.
    await expect(library.revertMetadata(token!)).rejects.toMatchObject({ code: 'undo_unavailable' })
  })

  it('refuses to undo over a change made since', async () => {
    const { library, store, paperId } = await webPaper()
    const token = await library.editMetadata(paperId, { title: 'Edited title' })
    const file = join(store.paperDir(paperId), 'paper.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^title: .*$/m, 'title: Edited elsewhere'))
    await expect(library.revertMetadata(token!)).rejects.toMatchObject({ code: 'undo_unavailable' })
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value.title).toBe('Edited elsewhere')
  })

  it('writes nothing for an edit that changes nothing, and refuses an empty title', async () => {
    const { library, store, paperId } = await webPaper()
    const before = await store.readPaper(paperId)
    expect(await library.editMetadata(paperId, { title: before.ok ? before.value.title : '' })).toBeNull()
    const same = await store.readPaper(paperId)
    expect(same.ok && same.value.updated_at).toBe(before.ok && before.value.updated_at)
    await expect(library.editMetadata(paperId, { title: ' ' })).rejects.toMatchObject({ code: 'invalid_edit' })
  })

  it('waits for the sync to let go of the folder before writing', async () => {
    const { library, store, paperId } = await webPaper()
    let release!: () => void
    const sync = store.exclusive(() => new Promise<void>((r) => (release = r)))
    let done = false
    const edit = library.editMetadata(paperId, { title: 'Edited during a sync' }).then(() => (done = true))
    await tick()
    expect(done).toBe(false)
    release()
    await sync
    await edit
    const read = await store.readPaper(paperId)
    expect(read.ok && read.value.title).toBe('Edited during a sync')
  })
})
