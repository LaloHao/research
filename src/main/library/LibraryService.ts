import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { IngestStatus, PaperDetail, PaperRow } from '../../shared/library'
import type { Paper } from '../../shared/schemas'
import type { ExtractionFile, FacetDef } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import { writeLibraryBib } from '../export/BibExporter'
import { chunkSegments } from '../extract/chunker'
import { isTextless, type PdfExtractor, type PdfText } from '../extract/PdfExtractor'
import { baseCitekey, uniqueCitekey } from '../ingest/citekey'
import type { HttpClient } from '../ingest/http'
import { findIdentifiersInText, parseInput } from '../ingest/identifiers'
import type { MetadataSource } from '../ingest/MetadataResolver'
import type { ResolvedMetadata } from '../ingest/types'
import { captureWebPage, findScholarlyIds, webMetadata } from '../ingest/web'
import { sha256 } from '../project/atomicWrite'
import { ConflictError } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { loadForm } from '../summary/extractionForm'
import { currentThesisHash, indexSummary } from '../summary/SummaryService'
import { entryFitsFacet, thesisRelationOutdated } from '../summary/merge'
import { buildPaper, compact } from './buildPaper'
import { findDuplicate, mergePapers, samePaperContent } from './dedupe'
import { toUserFacing, UserFacingError } from './UserFacingError'

/**
 * The extraction as the UI should see it: a facet entry whose stored shape no longer fits its facet's current type
 * (the facet was removed and recreated with a different type) is dropped, so the detail/review UI never renders
 * it or lets the user verify/edit it. The file on disk is left untouched; the next regeneration overwrites it (see
 * mergeExtraction).
 */
function visibleExtraction(extraction: ExtractionFile | null, facets: FacetDef[] | null): ExtractionFile | null {
  if (!extraction || !facets) return extraction
  const defByKey = new Map(facets.map((d) => [d.key, d]))
  const filtered = Object.fromEntries(Object.entries(extraction.facets).filter(([k, entry]) => {
    const def = defByKey.get(k)
    return !def || entryFitsFacet(def, entry)
  }))
  return { ...extraction, facets: filtered }
}

export interface IngestOutcome {
  status: IngestStatus
  paperId: string
}

export interface LibraryDeps {
  store: ProjectStore
  cache: IndexCache
  resolver: MetadataSource
  http: HttpClient
  extractor: PdfExtractor
  now?: () => Date
}

interface AddExtras {
  pdf?: Uint8Array
  content?: string
  /** Checked before anything is written: a cancelled job leaves the library untouched. */
  signal?: AbortSignal
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9'

export class LibraryService {
  private readonly listeners = new Set<() => void>()
  private readonly indexing = new Map<string, Promise<void>>()
  private readonly reading = new Map<string, Promise<Uint8Array | null>>()
  /** Text extracted during an ingest, keyed by PDF sha256, so indexing the new paper does not parse it again. */
  private readonly extracted = new Map<string, PdfText>()
  private bibRun: Promise<void> | null = null
  private bibNext: Promise<void> | null = null
  private addQueue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(private readonly deps: LibraryDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async ingestIdentifier(input: string, signal?: AbortSignal): Promise<IngestOutcome> {
    const parsed = parseInput(input)
    try {
      switch (parsed.kind) {
        case 'invalid':
          throw new UserFacingError('invalid_identifier')
        case 'doi':
          return await this.add(await this.deps.resolver.byDoi(parsed.doi, signal), { signal })
        case 'arxiv':
          return await this.add(await this.deps.resolver.byArxiv(parsed.arxiv, signal), { signal })
        case 'openalex':
          return await this.add(await this.deps.resolver.byOpenAlex(parsed.openalex, signal), { signal })
        case 'url':
          return await this.ingestUrl(parsed.url, signal)
      }
    } catch (error) {
      throw toUserFacing(error)
    }
  }

  async ingestPdf(path: string, signal?: AbortSignal): Promise<IngestOutcome> {
    try {
      const bytes = new Uint8Array(await readFile(path))
      return await this.ingestPdfBytes(bytes, basename(path), undefined, signal)
    } catch (error) {
      throw toUserFacing(error)
    }
  }

  /** The local PDF, downloading the open-access copy first when only its URL is known. Concurrent calls for one id share the download. */
  readPdf(id: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const pending = this.reading.get(id)
    if (pending) return pending
    const run = this.doReadPdf(id, signal).finally(() => this.reading.delete(id))
    this.reading.set(id, run)
    return run
  }

  private async doReadPdf(id: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const { store } = this.deps
    if (!store.resolvePdf(id)) {
      const read = await store.readPaper(id)
      if (!read.ok || !read.value.oa_pdf_url) return null
      try {
        const sha = await this.downloadPdf(id, read.value.oa_pdf_url, signal)
        if (!read.value.pdf_sha256) {
          // Recording the hash is best effort: if paper.yaml changed meanwhile, the PDF is still good.
          await store
            .writePaper({ ...read.value, pdf_sha256: sha, updated_at: this.now().toISOString() }, read.hash)
            .catch((error: unknown) => {
              if (!(error instanceof ConflictError)) throw error
            })
        }
      } catch (error) {
        throw toUserFacing(error)
      }
      await this.afterWrite(id)
    }
    const path = store.resolvePdf(id)
    return path ? new Uint8Array(await readFile(path)) : null
  }

  /** Re-resolves metadata from the paper's DOI/arXiv id, or from one the user typed. The id never changes. */
  async updateMetadata(id: string, input?: string, signal?: AbortSignal): Promise<IngestOutcome> {
    const { store, resolver } = this.deps
    try {
      const read = await store.readPaper(id)
      if (!read.ok) throw new UserFacingError('file_problem')
      let { doi, arxiv } = read.value.identifiers
      if (input?.trim()) {
        const parsed = parseInput(input)
        if (parsed.kind === 'doi') [doi, arxiv] = [parsed.doi, undefined]
        else if (parsed.kind === 'arxiv') [doi, arxiv] = [undefined, parsed.arxiv]
        else throw new UserFacingError('invalid_identifier')
      }
      const meta = doi ? await resolver.byDoi(doi, signal) : arxiv ? await resolver.byArxiv(arxiv, signal) : null
      if (!meta) throw new UserFacingError('no_identifier')
      const fresh = buildPaper(meta, id, this.now())
      const updated: Paper = {
        ...read.value,
        kind: fresh.kind,
        title: fresh.title,
        authors: fresh.authors,
        year: fresh.year,
        venue: fresh.venue,
        abstract: fresh.abstract ?? read.value.abstract,
        oa_pdf_url: fresh.oa_pdf_url ?? read.value.oa_pdf_url,
        bibtex: fresh.bibtex,
        metadata_status: fresh.metadata_status,
        identifiers: { ...compact(read.value.identifiers), ...compact(fresh.identifiers) },
        updated_at: fresh.updated_at
      }
      await store.writePaper(compact(updated) as Paper, read.hash)
      await this.afterWrite(id)
      return { status: 'merged', paperId: id }
    } catch (error) {
      throw toUserFacing(error)
    }
  }

  readNotes(id: string): Promise<{ text: string; hash: string | null }> {
    return this.deps.store.readNotes(id)
  }

  async writeNotes(id: string, text: string, expectedHash: string | null): Promise<{ ok: true; hash: string } | { ok: false; reason: 'conflict' }> {
    try {
      return { ok: true, hash: await this.deps.store.writeNotes(id, text, expectedHash) }
    } catch (error) {
      if (error instanceof ConflictError) return { ok: false, reason: 'conflict' }
      throw error
    }
  }

  list(query = ''): PaperRow[] {
    const rows = this.deps.cache.listPapers()
    if (!query.trim()) return rows
    const byId = new Map(rows.map((r) => [r.id, r]))
    return this.deps.cache.search(query, 200).flatMap((id) => byId.get(id) ?? [])
  }

  async detail(id: string): Promise<PaperDetail> {
    const { store, cache } = this.deps
    const read = await store.readPaper(id)
    const summary = await store.readSummary(id)
    const extraction = await store.readExtraction(id)
    const form = loadForm(store.config.extraction_form)
    const extractionValue = extraction?.ok ? extraction.value : null
    return {
      id,
      paper: read.ok ? read.value : null,
      problem: read.ok ? null : `${read.problem.kind}: ${read.problem.message}`,
      problemKind: read.ok ? null : read.problem.kind,
      hasPdf: store.resolvePdf(id) !== null || Boolean(read.ok && read.value.oa_pdf_url),
      textStatus: cache.getPaper(id)?.text_status ?? 'pending',
      content: await store.readContent(id),
      summary: summary?.ok ? summary.value : null,
      extraction: visibleExtraction(extractionValue, form.status === 'ok' ? form.form.facets : null),
      form: form.status === 'ok' ? form.form : null,
      summaryStatus: cache.getPaper(id)?.summary_status ?? 'none',
      summaryError: cache.summaryError(id),
      thesisOutdated: thesisRelationOutdated(extractionValue, currentThesisHash(store))
    }
  }

  /** Brings the cache row and text index of one paper up to date. Calls for the same id run in order. */
  indexPaper(id: string): Promise<void> {
    const previous = this.indexing.get(id) ?? Promise.resolve()
    const next = previous.then(
      () => this.doIndex(id),
      () => this.doIndex(id)
    )
    this.indexing.set(id, next)
    const cleanup = (): void => {
      if (this.indexing.get(id) === next) this.indexing.delete(id)
    }
    next.then(cleanup, cleanup)
    return next
  }

  async reindexAll(): Promise<void> {
    const ids = await this.deps.store.listPaperIds()
    const known = new Set(ids)
    for (const id of this.deps.cache.paperIds()) if (!known.has(id)) this.deps.cache.removePaper(id)
    for (const id of ids) await this.indexPaper(id)
    await this.exportBib()
    this.emit()
  }

  /** One export runs at a time; calls made meanwhile share a single trailing rerun, so the last write sees the latest state. */
  exportBib(): Promise<void> {
    if (!this.bibRun) {
      this.bibRun = this.writeBib().finally(() => {
        this.bibRun = null
      })
      return this.bibRun
    }
    this.bibNext ??= this.bibRun
      .catch(() => undefined)
      .then(() => {
        this.bibNext = null
        return this.exportBib()
      })
    return this.bibNext
  }

  private async writeBib(): Promise<void> {
    const { store } = this.deps
    const papers: Paper[] = []
    for (const id of await store.listPaperIds()) {
      const read = await store.readPaper(id)
      if (read.ok) papers.push(read.value)
    }
    await writeLibraryBib(join(store.exportsDir, 'library.bib'), papers)
  }

  protected async ingestUrl(url: string, signal?: AbortSignal): Promise<IngestOutcome> {
    // The URL may serve a large PDF: allow the download timeout for its body.
    const res = await this.deps.http.get(url, HTML_ACCEPT, signal, this.deps.http.downloadTimeoutMs)
    if ((res.headers.get('content-type') ?? '').includes('application/pdf')) {
      return this.ingestPdfBytes(new Uint8Array(await res.arrayBuffer()), basename(new URL(url).pathname), url, signal)
    }
    const html = await res.text()
    const ids = findScholarlyIds(html)
    if (ids.doi) return this.add(await this.deps.resolver.byDoi(ids.doi, signal), { signal })
    if (ids.arxiv) return this.add(await this.deps.resolver.byArxiv(ids.arxiv, signal), { signal })
    const capture = captureWebPage(html, url)
    if (!capture) throw new UserFacingError('unreadable_page')
    return this.add(webMetadata(capture, url), { content: `# ${capture.title}\n\nSource: ${url}\n\n${capture.markdown}\n`, signal })
  }

  protected async ingestPdfBytes(bytes: Uint8Array, fileName: string, sourceUrl: string | undefined, signal?: AbortSignal): Promise<IngestOutcome> {
    if (!isPdf(bytes)) throw new UserFacingError('not_a_pdf')
    const text = await this.deps.extractor.extract(bytes)
    const ids = findIdentifiersInText(text.pages.slice(0, 2).map((p) => p.text).join('\n'))
    let meta: ResolvedMetadata | null = null
    if (ids.doi) meta = await this.deps.resolver.byDoi(ids.doi, signal).catch(() => null)
    if (!meta && ids.arxiv) meta = await this.deps.resolver.byArxiv(ids.arxiv, signal).catch(() => null)
    meta ??= {
      kind: 'other',
      title: text.info.title ?? firstLine(text.pages[0]?.text ?? '') ?? fileName.replace(/\.pdf$/i, ''),
      authors: text.info.author ? [{ family: text.info.author }] : [],
      identifiers: compact({ doi: ids.doi, arxiv: ids.arxiv, url: sourceUrl }),
      complete: false
    }
    // A PDF served directly by a URL can be fetched from it again.
    if (sourceUrl) meta = { ...meta, oa_pdf_url: meta.oa_pdf_url ?? sourceUrl }
    const sha = sha256(bytes)
    this.extracted.set(sha, text)
    try {
      return await this.add(meta, { pdf: bytes, signal })
    } finally {
      this.extracted.delete(sha)
    }
  }

  /** Dedupe + key assignment + write. Serialized so two jobs never claim the same paper. */
  protected add(meta: ResolvedMetadata, extras: AddExtras): Promise<IngestOutcome> {
    const run = this.addQueue.then(() => this.addNow(meta, extras))
    this.addQueue = run.catch(() => undefined)
    return run
  }

  private async addNow(meta: ResolvedMetadata, extras: AddExtras): Promise<IngestOutcome> {
    const { store, cache } = this.deps
    extras.signal?.throwIfAborted()
    const dup = findDuplicate({ doi: meta.identifiers.doi, arxiv: meta.identifiers.arxiv, title: meta.title }, cache.dedupeEntries())
    if (dup) {
      const current = await store.readPaper(dup.id)
      if (!current.ok) throw new UserFacingError('file_problem')
      extras.signal?.throwIfAborted()
      let merged = mergePapers(current.value, buildPaper(meta, dup.id, this.now()))
      if (extras.pdf && !store.resolvePdf(dup.id)) {
        merged = { ...merged, pdf_sha256: await store.writePdf(dup.id, extras.pdf, { redownloadable: Boolean(merged.oa_pdf_url) }) }
      }
      const changed = !samePaperContent(current.value, merged)
      if (changed) await store.writePaper(merged, current.hash)
      await this.afterWrite(dup.id)
      return { status: changed ? 'merged' : 'duplicate', paperId: dup.id }
    }
    const id = uniqueCitekey(baseCitekey({ authors: meta.authors, year: meta.year, title: meta.title, site: meta.web?.site }), (candidate) =>
      store.paperExists(candidate)
    )
    let paper = buildPaper(meta, id, this.now())
    if (extras.pdf) {
      paper = { ...paper, pdf_sha256: await store.writePdf(id, extras.pdf, { redownloadable: Boolean(paper.oa_pdf_url) }) }
    } else if (meta.oa_pdf_url && store.config.pdfs.policy !== 'download_on_demand') {
      const sha = await this.downloadPdf(id, meta.oa_pdf_url).catch(() => null)
      if (sha) paper = { ...paper, pdf_sha256: sha }
    }
    if (extras.content) await store.writeContent(id, extras.content)
    await store.writePaper(paper, null)
    await this.afterWrite(id)
    return { status: 'added', paperId: id }
  }

  protected async downloadPdf(id: string, url: string, signal?: AbortSignal): Promise<string> {
    const bytes = await this.deps.http.bytes(url, 'application/pdf', signal)
    if (!isPdf(bytes)) throw new UserFacingError('not_a_pdf')
    return this.deps.store.writePdf(id, bytes, { redownloadable: true })
  }

  protected async afterWrite(id: string): Promise<void> {
    await this.indexPaper(id)
    await this.exportBib()
    this.emit()
  }

  protected emit(): void {
    for (const listener of this.listeners) listener()
  }

  private async doIndex(id: string): Promise<void> {
    const { store, cache } = this.deps
    if (!store.paperExists(id)) {
      cache.removePaper(id)
      return
    }
    const read = await store.readPaper(id)
    if (!read.ok) {
      cache.setProblem(id, read.hash, read.problem)
      return
    }
    const pdfPath = store.resolvePdf(id)
    cache.upsertPaper(read.value, read.hash, pdfPath !== null)
    await this.indexText(id, pdfPath)
    await indexSummary(store, cache, id)
  }

  private async indexText(id: string, pdfPath: string | null): Promise<void> {
    const { store, cache, extractor } = this.deps
    if (pdfPath) {
      const bytes = new Uint8Array(await readFile(pdfPath))
      const hash = sha256(bytes)
      if (cache.textHash(id) === hash) return
      try {
        const text = this.extracted.get(hash) ?? (await extractor.extract(bytes))
        if (isTextless(text)) cache.setText(id, hash, 'no_text', [])
        else cache.setText(id, hash, 'ok', chunkSegments(text.pages))
      } catch {
        cache.setText(id, hash, 'error', [])
      }
      return
    }
    const content = await store.readContent(id)
    if (content !== null) {
      const hash = sha256(content)
      if (cache.textHash(id) !== hash) cache.setText(id, hash, 'ok', chunkSegments([{ page: null, text: content }]))
      return
    }
    if (cache.getPaper(id)?.text_status !== 'no_source') cache.setText(id, null, 'no_source', [])
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
}

function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 10 && l.length <= 200)
}
