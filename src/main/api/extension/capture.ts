import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import type { JobRecord } from '../../../shared/jobs'
import { parseUserError } from '../../../shared/library'
import type { ImageFetcher } from '../../capture/reader'
import { suppliedImageFetcher } from '../../capture/reader'
import { findScholarlyIds } from '../../ingest/web'
import { parseInput } from '../../ingest/identifiers'
import type { CaptureInput, IngestOutcome } from '../../library/LibraryService'
import { toUserFacing, UserFacingError } from '../../library/UserFacingError'
import { findDuplicate, type DedupeEntry } from '../../library/dedupe'
import { pageIds, type CapturedPage } from './payload'

/** What the capture endpoints do with the open project (built by AppController from the session). */
export interface CaptureLibrary {
  dedupeEntries(): DedupeEntry[]
  /** The paper's title in the index; null when there is no such paper in the library. */
  title(key: string): string | null
  findByUrl(url: string): Promise<string | null>
  /** The «Agregar» box's flow: a queued `ingest_identifier` job, shown in Actividad. */
  enqueueIdentifier(input: string): number
  whenDone(job: number, timeoutMs: number): Promise<JobRecord | null>
  ingestCapture(capture: CaptureInput): Promise<IngestOutcome>
  ingestPdf(bytes: Uint8Array, fileName: string, sourceUrl: string): Promise<IngestOutcome>
  replacePdf(key: string, pdf: Uint8Array): Promise<void>
  /** Focuses the app's window on the paper. */
  open(key: string): void
}

/** The reader-view PDF of a page (the hidden print window); null when the page has no article. */
export type ReaderPrinter = (html: string, url: string, fetchImage: ImageFetcher) => Promise<Uint8Array | null>

export interface CaptureDeps {
  /** Null when no project is open. */
  library: () => CaptureLibrary | null
  printReader: ReaderPrinter
}

export type TaskState = 'running' | 'done' | 'failed'
export type TaskOutcome = 'added' | 'merged' | 'duplicate' | 'pdf_updated'

/** `capture_status`: where a capture is, and once done the paper's key. */
export interface TaskStatus {
  state: TaskState
  key: string | null
  title: string | null
  outcome: TaskOutcome | null
  /** A user error code (the extension translates it). */
  error: string | null
  /** The Actividad job of an identifier capture. */
  job: number | null
}

export interface Existing {
  key: string
  title: string
}

/** How long an identifier job is waited on before its task gives up (it goes on in Actividad). */
const JOB_WAIT_MS = 15 * 60_000
/** Finished tasks kept for `capture_status`. */
const MAX_TASKS = 200

export class CaptureFailure extends Error {
  constructor(readonly code: 'no_project' | 'not_found' | 'mismatch' | 'invalid' | 'capture_no_pdf') {
    super(code)
    this.name = 'CaptureFailure'
  }
}

const outcomeOf = (status: string | null): TaskOutcome =>
  status === 'merged' || status === 'duplicate' ? status : status === 'pdf_attached' ? 'pdf_updated' : 'added'

/**
 * The capture endpoints' work, apart from HTTP: a page sent by the browser extension becomes a paper exactly as one
 * added from the app's browser. A DOI or arXiv id on it takes the identifier path (with the PDF it brought, if any);
 * a PDF tab is ingested as a dropped PDF; any other page gets its readable text and the reader-view PDF printed in the
 * hidden window, with the images the extension sent instead of fetched ones. Nothing from the page runs in the app:
 * its HTML is only parsed (Readability, then the reader view's sanitizer). Each capture is a task the popup polls.
 */
export class ExtensionCapture {
  private readonly tasks = new Map<string, TaskStatus>()

  constructor(private readonly deps: CaptureDeps) {}

  private lib(): CaptureLibrary {
    const library = this.deps.library()
    if (!library) throw new CaptureFailure('no_project')
    return library
  }

  /** `capture_lookup`: the paper this page already is (same DOI or arXiv id, or same URL), if any. */
  async lookup(input: { url: string; final_url?: string; doi?: string; arxiv?: string }): Promise<Existing | null> {
    const lib = this.lib()
    const ids = pageIds({ ...(input.doi ? { citation_doi: [input.doi] } : {}), ...(input.arxiv ? { citation_arxiv_id: [input.arxiv] } : {}) }, [input.url, input.final_url ?? input.url])
    return this.existing(lib, ids, [input.url, input.final_url])
  }

  private async existing(lib: CaptureLibrary, ids: { doi?: string; arxiv?: string }, urls: (string | undefined)[]): Promise<Existing | null> {
    if (ids.doi || ids.arxiv) {
      // No title: a page title matching a paper's is not the same paper.
      const dup = findDuplicate({ doi: ids.doi, arxiv: ids.arxiv, title: '' }, lib.dedupeEntries())
      if (dup) return this.withTitle(lib, dup.id)
    }
    for (const url of new Set(urls.filter((u): u is string => Boolean(u)))) {
      const key = await lib.findByUrl(url)
      if (key) return this.withTitle(lib, key)
    }
    return null
  }

  private withTitle(lib: CaptureLibrary, key: string): Existing | null {
    const title = lib.title(key)
    return title === null ? null : { key, title }
  }

  /** `capture_identifier`: the «Agregar» flow (a job in Actividad) for a DOI, arXiv id, OpenAlex id or URL. */
  async identifier(input: { identifier: string; page_url?: string }): Promise<{ task: string; job: number; existing: Existing | null }> {
    const lib = this.lib()
    const parsed = parseInput(input.identifier)
    if (parsed.kind === 'invalid') throw new CaptureFailure('invalid')
    const ids = parsed.kind === 'doi' ? { doi: parsed.doi } : parsed.kind === 'arxiv' ? { arxiv: parsed.arxiv } : {}
    const existing = await this.existing(lib, ids, [parsed.kind === 'url' ? parsed.url : undefined, input.page_url])
    const job = lib.enqueueIdentifier(input.identifier.trim())
    const task = this.track(
      lib.whenDone(job, JOB_WAIT_MS).then((record) => {
        if (!record) return { state: 'running' as const }
        if (record.state === 'done') return { key: record.paperId, outcome: outcomeOf(record.message) }
        throw new UserFacingError(parseUserError(record.message ?? '')?.code ?? 'unknown')
      }),
      job
    )
    return { task, job, existing }
  }

  /**
   * `capture_page`: a page already in the library answers `existing` and adds nothing (the popup offers «Actualizar
   * PDF»); otherwise the capture starts and its task id comes back.
   */
  async page(page: CapturedPage, sentUrl: string): Promise<{ task: string | null; existing: Existing | null }> {
    const lib = this.lib()
    const ids = this.idsOf(page, sentUrl)
    const existing = await this.existing(lib, ids, [sentUrl, page.url])
    if (existing) return { task: null, existing }
    const task = this.track(
      (async () => {
        const outcome = await this.ingest(lib, page, ids)
        return { key: outcome.paperId, outcome: outcomeOf(outcome.status) }
      })(),
      null
    )
    return { task, existing: null }
  }

  /** `capture_update_pdf`: only for the paper this page is (what `capture_lookup` answers for it). */
  async updatePdf(key: string, page: CapturedPage, sentUrl: string): Promise<{ task: string }> {
    const lib = this.lib()
    if (lib.title(key) === null) throw new CaptureFailure('not_found')
    const found = await this.existing(lib, this.idsOf(page, sentUrl), [sentUrl, page.url])
    if (found?.key !== key) throw new CaptureFailure('mismatch')
    const task = this.track(
      (async () => {
        const pdf = page.pdf ?? (page.html ? await this.readerPdf(page) : null)
        if (!pdf) throw new UserFacingError('capture_no_pdf')
        await lib.replacePdf(key, pdf)
        return { key, outcome: 'pdf_updated' as const }
      })(),
      null
    )
    return { task }
  }

  /** `capture_status`; null for an unknown task. */
  status(task: string): TaskStatus | null {
    const status = this.tasks.get(task)
    if (!status) return null
    if (status.key && status.title === null) status.title = this.deps.library()?.title(status.key) ?? null
    return { ...status }
  }

  /** `open_in_app`: the app's window comes to the front with the paper. */
  open(key: string): void {
    const lib = this.lib()
    if (lib.title(key) === null) throw new CaptureFailure('not_found')
    lib.open(key)
  }

  private idsOf(page: CapturedPage, sentUrl: string): { doi?: string; arxiv?: string } {
    const fromMeta = pageIds(page.meta, [sentUrl, page.url])
    const fromHtml = page.html ? findScholarlyIds(page.html) : {}
    return { doi: fromMeta.doi ?? fromHtml.doi, arxiv: fromMeta.arxiv ?? fromHtml.arxiv }
  }

  private async ingest(lib: CaptureLibrary, page: CapturedPage, ids: { doi?: string; arxiv?: string }): Promise<IngestOutcome> {
    const known = Object.fromEntries(Object.entries(ids).filter(([, v]) => v)) as { doi?: string; arxiv?: string }
    if (known.doi || known.arxiv) return lib.ingestCapture({ url: page.url, html: page.html, pdf: page.pdf, ids: known })
    // A PDF tab: the PDF is the paper, its identifiers read from its first pages.
    if (page.pdf && !page.html.trim()) return lib.ingestPdf(page.pdf, pdfName(page.url), page.url)
    const pdf = page.pdf ?? (await this.readerPdf(page))
    return lib.ingestCapture({ url: page.url, html: page.html, pdf })
  }

  private async readerPdf(page: CapturedPage): Promise<Uint8Array | null> {
    return this.deps.printReader(page.html, page.url, suppliedImageFetcher(page.images)).catch(() => null)
  }

  private track(work: Promise<{ key?: string | null; outcome?: TaskOutcome; state?: 'running' }>, job: number | null): string {
    const id = randomBytes(12).toString('base64url')
    const status: TaskStatus = { state: 'running', key: null, title: null, outcome: null, error: null, job }
    this.tasks.set(id, status)
    while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!)
    work.then(
      (result) => {
        if (result.state === 'running') return
        status.state = 'done'
        status.key = result.key ?? null
        status.outcome = result.outcome ?? null
      },
      (error: unknown) => {
        status.state = 'failed'
        status.error = error instanceof CaptureFailure ? error.code : toUserFacing(error).code
      }
    )
    return id
  }
}

/** A file name for a PDF tab's paper: the last part of its path, or `document.pdf`. */
export function pdfName(url: string): string {
  try {
    const name = basename(decodeURIComponent(new URL(url).pathname))
    return name && name !== '/' ? (name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`) : 'document.pdf'
  } catch {
    return 'document.pdf'
  }
}

