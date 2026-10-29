import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { authorsLabel } from '../../shared/format'
import type { IngestStatus, MetadataEdit, PaperDetail, PaperRow } from '../../shared/library'
import type { Paper } from '../../shared/schemas'
import type { ExtractionFile, FacetDef } from '../../shared/summary'
import type { DeletePlan, RestoreConflict, RestoreOutcome, TrashEntry, TrashOutcome, TrashProblem, TrashTarget } from '../../shared/trash'
import type { IndexCache, TrashRow } from '../cache/IndexCache'
import { chunkSegments } from '../extract/chunker'
import { isTextless, type PdfExtractor, type PdfText } from '../extract/PdfExtractor'
import { rekeyBibtex } from '../ingest/bibtex'
import { baseCitekey, uniqueCitekey } from '../ingest/citekey'
import { HttpError, isOpenAlexUrl, type HttpClient } from '../ingest/http'
import { findIdentifiersInText, normalizeDoi, parseInput } from '../ingest/identifiers'
import type { MetadataSource } from '../ingest/MetadataResolver'
import type { ResolvedMetadata } from '../ingest/types'
import { bareWebMetadata, captureWebPage, findScholarlyIds, normalizePageUrl, webContent, webMetadata } from '../ingest/web'
import { sha256 } from '../project/atomicWrite'
import { ConflictError, type ReadResult } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { loadForm } from '../summary/extractionForm'
import { currentThesisHash, indexSummary } from '../summary/SummaryService'
import { entryFitsFacet, thesisRelationOutdated } from '../summary/merge'
import { buildPaper, compact } from './buildPaper'
import { applyMetadataEdit } from './metadataEdit'
import { findDuplicate, mergePapers, samePaperContent } from './dedupe'
import { mergeNotes, planMergeFile } from './trashMerge'
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

/** Names the device in trashed.yaml (and the cost log) when the app settings did not give one. */
export const DEFAULT_DEVICE_ID = '00000000-0000-0000-0000-000000000000'

/** relations.yaml as the trash needs it, always through RelationService's hash-checked writes. */
export interface TrashRelations {
  countTouching(ids: string[]): Promise<number>
  removeTouching(ids: string[]): Promise<number>
  rekey(from: string, to: string): Promise<void>
}

export interface LibraryDeps {
  store: ProjectStore
  cache: IndexCache
  resolver: MetadataSource
  http: HttpClient
  extractor: PdfExtractor
  now?: () => Date
  /** Written into trashed.yaml; the same id names this device's cost log. */
  deviceId?: string
  /** Cancels the queued and running jobs of these papers, resolving once none of them still runs. */
  cancelJobs?: (ids: string[]) => Promise<unknown>
  /** Cancels only the queued jobs of these papers (synchronous; safe inside the serial queue). */
  cancelQueued?: (ids: string[]) => unknown
  relations?: TrashRelations
}

interface AddExtras {
  pdf?: Uint8Array
  content?: string
  /** Checked before anything is written: a cancelled job leaves the library untouched. */
  signal?: AbortSignal
}

const MAX_METADATA_UNDO = 100

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9'

export class LibraryService {
  private readonly listeners = new Set<() => void>()
  private readonly indexing = new Map<string, Promise<void>>()
  private readonly reading = new Map<string, Promise<Uint8Array | null>>()
  /** Text extracted during an ingest, keyed by PDF sha256, so indexing the new paper does not parse it again. */
  private readonly extracted = new Map<string, PdfText>()
  /** Undo token of a metadata edit → the paper before it and the hash of what it wrote. */
  private readonly metadataUndo = new Map<string, { id: string; before: Paper; hash: string }>()
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
      const bytes = await readPdfFile(path)
      return await this.ingestPdfBytes(bytes, basename(path), undefined, signal)
    } catch (error) {
      throw toUserFacing(error)
    }
  }

  /** A paper from metadata the app already has (a mapping's record): the same dedupe, key, open-access PDF and write as any ingest. */
  async ingestMetadata(meta: ResolvedMetadata, signal?: AbortSignal): Promise<IngestOutcome> {
    try {
      return await this.add(meta, { signal })
    } catch (error) {
      throw toUserFacing(error)
    }
  }

  /**
   * Attaches the PDF at `path` to an existing paper, or replaces its PDF when `replace` is set. Only the PDF and
   * `pdf_sha256` change: no metadata is resolved or merged. Its text is extracted and indexed in place of the old
   * one; summaries are left as they are. Serialized with ingests so a merge never races with it.
   */
  attachPdf(id: string, path: string, { replace }: { replace: boolean }, signal?: AbortSignal): Promise<{ status: 'pdf_attached'; paperId: string }> {
    const run = this.addQueue.then(() => this.attachNow(id, () => readPdfFile(path), replace, signal))
    this.addQueue = run.catch(() => undefined)
    return run
  }

  /**
   * «Actualizar su PDF» from the app's browser: a page captured again replaces the PDF of the paper it already is,
   * exactly as «Reemplazar PDF» (summaries stay; the new text is indexed).
   */
  replaceCapturedPdf(id: string, pdf: Uint8Array): Promise<{ status: 'pdf_attached'; paperId: string }> {
    const run = this.addQueue.then(() =>
      this.attachNow(
        id,
        async () => {
          if (!isPdf(pdf)) throw new UserFacingError('not_a_pdf')
          return pdf
        },
        true
      )
    )
    this.addQueue = run.catch(() => undefined)
    return run
  }

  /**
   * The library paper whose URL is this page's (compared normalized: scheme, «www.», fragment, tracking parameters and
   * a trailing slash don't count); null when there is none. Reads each paper.yaml: the index keeps no URLs.
   */
  async findByUrl(url: string): Promise<string | null> {
    const wanted = normalizePageUrl(url)
    if (!wanted) return null
    for (const { id } of this.deps.cache.dedupeEntries()) {
      const read = await this.deps.store.readPaper(id).catch(() => null)
      const own = read?.ok ? read.value.identifiers.url : undefined
      if (own && normalizePageUrl(own) === wanted) return id
    }
    return null
  }

  private async attachNow(
    id: string,
    load: () => Promise<Uint8Array>,
    replace: boolean,
    signal?: AbortSignal
  ): Promise<{ status: 'pdf_attached'; paperId: string }> {
    const { store, extractor } = this.deps
    try {
      signal?.throwIfAborted()
      if (!store.paperExists(id)) throw new UserFacingError('file_problem')
      const before = await store.readPaper(id)
      if (!before.ok) throw new UserFacingError('file_problem')
      if (store.resolvePdf(id) && !replace) throw new UserFacingError('pdf_exists')
      const bytes = await load()
      // Parsed before anything is written: a corrupt file leaves the paper as it was.
      const text = await extractor.extract(bytes)
      signal?.throwIfAborted()
      // A file the user chose or captured can't be downloaded again: it always goes in the paper folder, and a cached copy would only shadow nothing.
      const sha = await store.writePdf(id, bytes, { redownloadable: false })
      this.extracted.set(sha, text)
      try {
        await store.removeCachedPdf(id)
        await this.recordPdfHash(id, sha)
      } finally {
        // Whatever happened to paper.yaml, the index and the UI must match the PDF now on disk.
        await this.afterWrite(id).finally(() => this.extracted.delete(sha))
      }
      return { status: 'pdf_attached', paperId: id }
    } catch (error) {
      if (signal?.aborted) throw error
      throw toUserFacing(error)
    }
  }

  /** Writes `pdf_sha256` from a fresh read of paper.yaml, retrying once if it changed between that read and the write. */
  private async recordPdfHash(id: string, sha: string): Promise<void> {
    const { store } = this.deps
    for (let attempt = 0; ; attempt++) {
      const read = await store.readPaper(id)
      if (!read.ok) throw new UserFacingError('file_problem')
      if (read.value.pdf_sha256 === sha) return
      try {
        await store.writePaper({ ...read.value, pdf_sha256: sha, updated_at: this.now().toISOString() }, read.hash)
        return
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt > 0) throw error
      }
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
    // A replacement may remove the cached copy between resolving and reading it: resolve once more before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const path = store.resolvePdf(id)
      if (!path) return null
      try {
        return new Uint8Array(await readFile(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return null
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
      const before = read.value.identifiers
      const identifiers = { ...compact(before), ...compact(fresh.identifiers) }
      const doiChanged = (before.doi ? normalizeDoi(before.doi) : null) !== (identifiers.doi ? normalizeDoi(identifiers.doi) : null)
      // An OpenAlex id kept from the old DOI would point at another work: it goes unless the new metadata brought its own.
      if (doiChanged && !fresh.identifiers.openalex) delete identifiers.openalex
      // Citations of another work go too, so the citations job that follows a metadata update fetches them again.
      const fetchedId = read.value.citations?.openalex_id
      const stale = doiChanged || (!!fetchedId && !!identifiers.openalex && fetchedId !== identifiers.openalex)
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
        identifiers,
        updated_at: fresh.updated_at
      }
      if (stale) delete updated.citations
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
    return this.exclusive(id, () => this.doIndex(id))
  }

  /** Work on one paper's folder and index rows (indexing, a trash move, a restore) runs one at a time per paper. */
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.indexing.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.indexing.set(id, settled)
    void settled.then(() => {
      if (this.indexing.get(id) === settled) this.indexing.delete(id)
    })
    return next
  }

  /** Ingests, merges, PDF attachments and trash operations run one at a time, so none of them races another over a folder. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.addQueue.then(fn)
    this.addQueue = run.catch(() => undefined)
    return run
  }

  /** An empty id in the settings counts as none. */
  private get deviceId(): string {
    return this.deps.deviceId || DEFAULT_DEVICE_ID
  }

  /** Deleting for good always goes through relations.yaml first; without that service nothing is deleted. */
  private requireRelations(): TrashRelations {
    if (!this.deps.relations) throw new Error('Deleting from the trash needs the relations service')
    return this.deps.relations
  }

  /** Never call it from inside `serial` (an ingest, attachment or trash operation): its `syncTrash` waits in that queue. */
  async reindexAll(): Promise<void> {
    await this.syncTrash()
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
    await store.writeBib(papers)
  }

  /**
   * «Quitar de la biblioteca»: cancels the papers' jobs first (outside the serial queue: a running PDF attachment waits in
   * it), then moves each folder to `.trash/`. Stops at the first failure; `moved` lists exactly what moved, for «Deshacer».
   */
  async trash(ids: string[]): Promise<TrashOutcome> {
    const unique = [...new Set(ids)]
    try {
      await this.deps.cancelJobs?.(unique)
    } catch (error) {
      return { moved: [], error: toUserFacing(error).code }
    }
    return this.serial(() => this.trashNow(unique))
  }

  private async trashNow(ids: string[]): Promise<TrashOutcome> {
    const { store, cache } = this.deps
    const moved: string[] = []
    let error: string | null = null
    try {
      for (const id of ids.filter((i) => store.paperExists(i))) {
        await this.exclusive(id, async () => {
          // Anything queued since the cancellation above (an automatic trigger) must not run on the moved folder.
          this.deps.cancelQueued?.([id])
          // A folder already in the trash under this key: refuse before the index changes.
          if (store.trashExists(id)) throw new UserFacingError('trash_problem')
          const read = await store.readPaper(id).catch(() => null)
          const now = this.now()
          // The index first: a reindex racing the move must find the entry and keep the paper's text.
          cache.moveToTrash(trashRow(id, read?.ok ? read.value : null, { trashed_at: now.toISOString(), device: this.deviceId }, null))
          try {
            await store.trashPaper(id, this.deviceId, now)
          } catch (failure) {
            // The folder did not move: the index goes back to what is on disk.
            cache.takeFromTrash(id)
            // A trash folder that appeared meanwhile under this key gets its entry back.
            if (store.trashExists(id)) await this.syncTrashNow()
            await this.doIndex(id)
            throw failure
          }
        })
        moved.push(id)
      }
    } catch (failure) {
      error = toUserFacing(failure).code
    }
    if (moved.length > 0) {
      await this.exportBib()
      this.emit()
    }
    return { moved, error }
  }

  /** Mirrors `.trash/` into the index (opening the project, a git pull, every listing), never in the middle of a move. */
  syncTrash(): Promise<void> {
    return this.serial(() => this.syncTrashNow())
  }

  private async syncTrashNow(): Promise<void> {
    const entries = await this.deps.store.listTrash()
    this.deps.cache.replaceTrash(entries.map((e) => trashRow(e.id, e.paper?.ok ? e.paper.value : null, e.trashed, trashProblem(e.paper))))
  }

  /** The trash as the Papelera shows it, re-read from `.trash/` so a trashed.yaml that arrived late by git is picked up. */
  async listTrash(): Promise<TrashEntry[]> {
    await this.syncTrash()
    return this.deps.cache.trashEntries().map((r) => ({
      id: r.id,
      title: r.title,
      authors_label: r.authors_label,
      year: r.year,
      trashed_at: r.trashed_at,
      device: r.device,
      this_device: r.device === this.deviceId,
      problem: r.problem as TrashProblem | null
    }))
  }

  /**
   * «Restaurar»: each paper goes back to `papers/`. When the same paper is already in the library (same DOI, arXiv id or
   * title) it stays in the trash as a conflict unless `merge` is set; when only its key was taken by another paper, it
   * comes back under a free key. Each paper succeeds or fails on its own.
   */
  restore(ids: string[], opts: { merge: boolean }): Promise<RestoreOutcome> {
    return this.serial(async () => {
      const outcome: RestoreOutcome = { restored: [], conflicts: [], failed: [] }
      for (const id of [...new Set(ids)]) {
        try {
          const r = await this.restoreOne(id, opts.merge)
          if ('conflict' in r) outcome.conflicts.push(r.conflict)
          else outcome.restored.push({ id, key: r.key, ...(r.remnant ? { remnant: true as const } : {}), ...(r.indexFailed ? { warning: 'index_failed' as const } : {}) })
        } catch (failure) {
          outcome.failed.push({ id, error: toUserFacing(failure).code })
        }
      }
      if (outcome.restored.length > 0) {
        await this.exportBib()
        this.emit()
      }
      return outcome
    })
  }

  private async restoreOne(id: string, merge: boolean): Promise<{ key: string; remnant: boolean; indexFailed?: boolean } | { conflict: RestoreConflict }> {
    const { store, cache } = this.deps
    if (!store.trashExists(id)) throw new UserFacingError('not_in_trash')
    const read = await store.readTrashedPaper(id)
    if (!read) throw new UserFacingError('trash_problem')
    const paper = read.ok ? read.value : null
    if (paper) {
      const dup = findDuplicate({ doi: paper.identifiers.doi, arxiv: paper.identifiers.arxiv, title: paper.title }, cache.dedupeEntries())
      if (dup && !merge) return { conflict: { id, title: paper.title, target: dup.id } }
      if (dup) return { key: dup.id, remnant: await this.mergeFromTrash(id, paper, dup.id) }
    }
    if (store.paperExists(id)) {
      // Re-keying needs a readable paper.yaml.
      if (!paper) throw new UserFacingError('trash_problem')
      return this.restoreAs(id)
    }
    return this.exclusive(id, async () => {
      const moved = await store.restorePaper(id)
      // The folder is back: from here on the paper counts as restored, even if indexing it fails.
      try {
        // Only once the folder moved: this puts the paper's text state back into the index.
        cache.takeFromTrash(id)
        // A remnant (a subfolder) keeps its folder in the trash: the index lists it again, with its problem.
        if (moved.remnant) await this.syncTrashNow()
        await this.doIndex(id)
        return { key: id, remnant: moved.remnant }
      } catch (failure) {
        console.error('restore: index', id, failure)
        return { key: id, remnant: moved.remnant, indexFailed: true }
      }
    })
  }

  /** Another paper took the key: this one comes back under the next free key, with paper.yaml, BibTeX and relations re-keyed. */
  private async restoreAs(id: string): Promise<{ key: string; remnant: boolean }> {
    const { store, cache } = this.deps
    const key = uniqueCitekey(id, (candidate) => existsSync(store.paperDir(candidate)) || store.trashExists(candidate))
    // relations.yaml first: it refuses during a git conflict, before anything moved. Relations naming `id` are
    // ambiguous here (the trashed paper's, or ones made for the library paper that took the key since): all of them
    // follow the restored paper, as the trashed paper is the one they were made for unless the user relinked meanwhile.
    await this.deps.relations?.rekey(id, key)
    let remnant: boolean
    try {
      remnant = await this.exclusive(key, async () => {
        const updated_at = this.now().toISOString()
        const moved = await store.restorePaper(id, { as: key, rewrite: (p) => ({ ...p, id: key, bibtex: rekeyedBibtex(p.bibtex, key), updated_at }) })
        cache.removeTrash(id)
        if (moved.remnant) await this.syncTrashNow()
        await this.doIndex(key)
        return moved.remnant
      })
    } catch (failure) {
      await this.deps.relations?.rekey(key, id).catch((undo: unknown) => console.error('relations back to', id, undo))
      throw failure
    }
    return { key, remnant }
  }

  /**
   * «Fusionar» (the same paper is in the library as `targetId`): paper.yaml merged as on a duplicate ingest (the library
   * key survives), both notes, and every other trashed file either taken (the library has none, or it is a more reviewed
   * summary/extraction; the library copy is then kept as `<name>.before-merge.<ext>`), skipped when identical, or kept
   * beside the library one as `<name>.trashed.<ext>`. Only the files it took leave the trash; true when something stayed.
   */
  private async mergeFromTrash(id: string, trashed: Paper, targetId: string): Promise<boolean> {
    const { store, cache } = this.deps
    // The target first, then relations.yaml (which refuses during a git conflict): both before any file changes.
    const target = await store.readPaper(targetId).catch(() => null)
    if (!target?.ok) throw new UserFacingError('file_problem')
    if (id !== targetId) await this.deps.relations?.rekey(id, targetId)
    try {
      return await this.mergeFilesFromTrash(id, trashed, targetId)
    } catch (failure) {
      // The entry stays in the trash: its relations go back to its own key.
      if (id !== targetId) await this.deps.relations?.rekey(targetId, id).catch((undo: unknown) => console.error('relations back to', id, undo))
      throw failure
    }
  }

  private mergeFilesFromTrash(id: string, trashed: Paper, targetId: string): Promise<boolean> {
    const { store, cache } = this.deps
    return this.exclusive(targetId, async () => {
      const taken: string[] = []
      let pdfAdopted = false
      for (const name of await store.listTrashedFiles(id)) {
        const theirs = name === 'paper.yaml' ? null : await store.readTrashedFile(id, name)
        if (theirs !== null && name === 'notes.md') {
          const mine = await store.readNotes(targetId)
          const next = mergeNotes(mine.text, new TextDecoder().decode(theirs), id)
          if (next !== mine.text) await store.writeNotes(targetId, next, mine.hash)
        } else if (theirs !== null) {
          const mine = await store.readPaperFile(targetId, name)
          const step = planMergeFile(name, mine, theirs)
          if (step === 'adopt') {
            if (mine !== null) await store.keepPaperFileAs(targetId, name, 'before-merge')
            await store.adoptTrashedFile(id, targetId, name, { expectedHash: null })
            if (name === 'paper.pdf') pdfAdopted = true
          } else if (step === 'keep_trashed') {
            await store.adoptTrashedFile(id, targetId, name, { as: store.freeSibling(targetId, name, 'trashed'), expectedHash: null })
          }
        }
        taken.push(name)
      }
      const current = await store.readPaper(targetId)
      if (!current.ok) throw new UserFacingError('file_problem')
      let merged: Paper = { ...mergePapers(current.value, trashed), updated_at: this.now().toISOString() }
      if (pdfAdopted && trashed.pdf_sha256) merged = { ...merged, pdf_sha256: trashed.pdf_sha256 }
      if (!samePaperContent(current.value, merged)) await store.writePaper(merged, current.hash)
      if (id !== targetId) await store.removeCachedPdf(id)
      // Something it did not take (a subfolder) keeps the entry in the trash.
      const done = await store.finishMerge(id, taken)
      if (done) cache.removeTrash(id)
      else await this.syncTrashNow()
      await this.doIndex(targetId)
      return !done
    })
  }

  /** What «Eliminar definitivamente» (these papers) or «Vaciar papelera» ('all') would delete: the confirmation sends `ids` back. */
  async deletePlan(target: TrashTarget): Promise<DeletePlan> {
    await this.syncTrash()
    const ids = this.trashTargets(target)
    const owned = this.relationOwners(ids)
    return { ids, papers: ids.length, relations: owned.length > 0 ? await this.requireRelations().countTouching(owned) : 0 }
  }

  /**
   * Deletes for good exactly these trashed papers (the ids a confirmation showed; keys no longer in the trash are
   * ignored). Their relations leave relations.yaml first; that write refuses while the file has a git conflict, and then
   * no folder is deleted either. Returns how many papers went.
   */
  deleteForever(ids: string[]): Promise<number> {
    return this.serial(async () => {
      const { store, cache } = this.deps
      const relations = this.requireRelations()
      await this.syncTrashNow()
      const targets = this.trashTargets(ids)
      if (targets.length === 0) return 0
      try {
        const owned = this.relationOwners(targets)
        if (owned.length > 0) await relations.removeTouching(owned)
        for (const id of targets) {
          await store.deleteTrashed(id)
          // A library paper that took the same key keeps its own cached PDF.
          if (!existsSync(store.paperDir(id))) await store.removeCachedPdf(id)
          cache.removeTrash(id)
        }
      } catch (failure) {
        throw toUserFacing(failure)
      } finally {
        this.emit()
      }
      return targets.length
    })
  }

  /** Trashed keys whose relations go with them: a key a library paper also uses (e.g. after a restore left a remnant) keeps its relations. */
  private relationOwners(ids: string[]): string[] {
    return ids.filter((id) => !this.deps.store.paperExists(id))
  }

  /** Keys of the target that are in the trash ('all': the whole trash, named explicitly). */
  private trashTargets(target: TrashTarget): string[] {
    const wanted = target === 'all' ? null : new Set(target)
    return this.deps.cache
      .trashEntries()
      .map((r) => r.id)
      .filter((id) => (wanted === null || wanted.has(id)) && this.deps.store.trashExists(id))
  }

  protected async ingestUrl(url: string, signal?: AbortSignal): Promise<IngestOutcome> {
    // The URL may serve a large PDF: allow the download timeout for its body.
    const res = await this.deps.http.get(url, HTML_ACCEPT, signal, this.deps.http.downloadTimeoutMs).catch((error: unknown) => {
      // A web page that refuses the app (bot protection, or a plain 401/403) opens in the app's browser instead.
      if (error instanceof HttpError && (error.status === 401 || error.status === 403) && !isOpenAlexUrl(error.url)) {
        throw new UserFacingError('site_blocked', { cause: error, detail: `HTTP ${error.status}` })
      }
      throw error
    })
    if ((res.headers.get('content-type') ?? '').includes('application/pdf')) {
      return this.ingestPdfBytes(new Uint8Array(await res.arrayBuffer()), basename(new URL(url).pathname), url, signal)
    }
    const html = await res.text()
    const ids = findScholarlyIds(html)
    if (ids.doi) return this.add(await this.deps.resolver.byDoi(ids.doi, signal), { signal })
    if (ids.arxiv) return this.add(await this.deps.resolver.byArxiv(ids.arxiv, signal), { signal })
    const capture = captureWebPage(html, url)
    if (!capture) throw new UserFacingError('unreadable_page')
    return this.add(webMetadata(capture, url), { content: webContent(capture, url), signal })
  }

  /**
   * A page the user opened in the app's browser and added from there: its HTML and final URL (untrusted, like any
   * downloaded page) and the PDF the browser printed of it. A DOI or arXiv id on the page takes the identifier path
   * (the PDF goes with it); otherwise it is a web page with its readable text, or with only its title when the
   * article cannot be extracted (incomplete metadata). Same dedupe, key and write as any ingest.
   */
  async ingestCapture(capture: { url: string; html: string; pdf: Uint8Array | null }, signal?: AbortSignal): Promise<IngestOutcome> {
    try {
      const { url, html } = capture
      const pdf = capture.pdf && isPdf(capture.pdf) ? capture.pdf : undefined
      const ids = findScholarlyIds(html)
      let meta: ResolvedMetadata | null = null
      if (ids.doi) meta = await this.deps.resolver.byDoi(ids.doi, signal).catch(() => null)
      if (!meta && ids.arxiv) meta = await this.deps.resolver.byArxiv(ids.arxiv, signal).catch(() => null)
      let content: string | undefined
      if (!meta) {
        const page = captureWebPage(html, url)
        meta = page ? webMetadata(page, url) : bareWebMetadata(html, url)
        if (page) content = webContent(page, url)
      }
      if (!pdf) return await this.add(meta, { content, signal })
      // Parsed before anything is written, and kept so indexing the new paper does not parse it again.
      const text = await this.deps.extractor.extract(pdf)
      const sha = sha256(pdf)
      this.extracted.set(sha, text)
      try {
        return await this.add(meta, { pdf, content, signal })
      } finally {
        this.extracted.delete(sha)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      throw toUserFacing(error)
    }
  }

  /**
   * «Editar metadatos»: title, authors, year or date, venue (a web page's site) and URL as the user typed them. The
   * BibTeX entry gets the same fields (its key and every other field stay); library.bib follows. The citation key
   * never changes. Returns the token «Deshacer» sends back; null when the edit changed nothing.
   */
  editMetadata(id: string, edit: MetadataEdit): Promise<string | null> {
    return this.serial(async () => {
      try {
        return await this.editNow(id, edit)
      } catch (error) {
        throw toUserFacing(error)
      }
    })
  }

  private async editNow(id: string, edit: MetadataEdit): Promise<string | null> {
    const { store } = this.deps
    const read = await store.readPaper(id)
    if (!read.ok) throw new UserFacingError('file_problem')
    const before = read.value
    const next = applyMetadataEdit(before, edit)
    // Nothing to write, nothing to undo.
    if (samePaperContent(before, next)) return null
    const hash = await store.writePaper({ ...next, updated_at: this.now().toISOString() }, read.hash)
    const token = randomUUID()
    this.metadataUndo.set(token, { id, before, hash })
    while (this.metadataUndo.size > MAX_METADATA_UNDO) this.metadataUndo.delete(this.metadataUndo.keys().next().value!)
    await this.afterWrite(id)
    return token
  }

  /** «Deshacer» of a metadata edit: only while paper.yaml is still what that edit wrote; the token is spent either way. */
  revertMetadata(token: string): Promise<void> {
    return this.serial(async () => {
      const change = this.metadataUndo.get(token)
      this.metadataUndo.delete(token)
      try {
        if (!change) throw new UserFacingError('undo_unavailable')
        const read = await this.deps.store.readPaper(change.id)
        if (!read.ok || read.hash !== change.hash) throw new UserFacingError('undo_unavailable')
        await this.deps.store.writePaper({ ...change.before, updated_at: this.now().toISOString() }, read.hash)
        await this.afterWrite(change.id)
      } catch (error) {
        throw toUserFacing(error)
      }
    })
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
    // A key in the trash stays reserved: restoring it later must not collide with a new paper. So does a folder without
    // paper.yaml (an untracked PDF left by a sync): a new paper must not inherit its files.
    const id = uniqueCitekey(baseCitekey({ authors: meta.authors, year: meta.year, title: meta.title, site: meta.web?.site }), (candidate) =>
      existsSync(store.paperDir(candidate)) || store.trashExists(candidate)
    )
    let paper = buildPaper(meta, id, this.now())
    if (extras.pdf) {
      paper = { ...paper, pdf_sha256: await store.writePdf(id, extras.pdf, { redownloadable: Boolean(paper.oa_pdf_url), newPaper: true }) }
    } else if (meta.oa_pdf_url && store.config.pdfs.policy !== 'download_on_demand') {
      const sha = await this.downloadPdf(id, meta.oa_pdf_url, undefined, { newPaper: true }).catch(() => null)
      if (sha) paper = { ...paper, pdf_sha256: sha }
    }
    if (extras.content) await store.writeContent(id, extras.content, { newPaper: true })
    await store.writePaper(paper, null)
    await this.afterWrite(id)
    return { status: 'added', paperId: id }
  }

  /** `newPaper`: the PDF of a paper whose paper.yaml is written right after. */
  protected async downloadPdf(id: string, url: string, signal?: AbortSignal, opts: { newPaper?: boolean } = {}): Promise<string> {
    const bytes = await this.deps.http.bytes(url, 'application/pdf', signal)
    if (!isPdf(bytes)) throw new UserFacingError('not_a_pdf')
    return this.deps.store.writePdf(id, bytes, { redownloadable: true, newPaper: opts.newPaper })
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

/** Largest PDF accepted from the user's disk. */
export const MAX_PDF_BYTES = 200 * 1024 * 1024

/** A PDF the user picked or dropped: a regular file of a sane size that starts like a PDF. */
async function readPdfFile(path: string): Promise<Uint8Array> {
  const info = await stat(path)
  if (!info.isFile()) throw new UserFacingError('not_a_pdf')
  if (info.size > MAX_PDF_BYTES) throw new UserFacingError('file_too_large')
  const bytes = new Uint8Array(await readFile(path))
  if (!isPdf(bytes)) throw new UserFacingError('not_a_pdf')
  return bytes
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

function trashRow(id: string, paper: Paper | null, trashed: { trashed_at: string; device: string } | null, problem: TrashProblem | null): TrashRow {
  return {
    id,
    title: paper?.title ?? id,
    authors_label: paper ? authorsLabel(paper.authors) : '',
    year: paper?.year ?? null,
    doi: paper?.identifiers.doi ?? null,
    openalex_id: paper?.citations?.openalex_id ?? paper?.identifiers.openalex ?? null,
    trashed_at: trashed?.trashed_at ?? null,
    device: trashed?.device ?? null,
    problem
  }
}

/** Why a trash folder cannot be restored as is; null when it can. */
function trashProblem(read: ReadResult<Paper> | null): TrashProblem | null {
  if (!read) return 'missing_paper_yaml'
  return read.ok ? null : read.problem.kind
}

/** The BibTeX of a paper restored under another key; unparseable BibTeX stays as it was (the export skips it anyway). */
function rekeyedBibtex(bibtex: string, key: string): string {
  try {
    return rekeyBibtex(bibtex, key)
  } catch {
    return bibtex
  }
}
