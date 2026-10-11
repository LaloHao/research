import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
import type { ReviewItem } from '../../shared/summary'
import type { DeletePlan, RestoreOutcome, TrashEntry, TrashOutcome, TrashTarget } from '../../shared/trash'
import { IndexCache } from '../cache/IndexCache'
import { CitationService } from '../citations/CitationService'
import { OpenAlexCitations } from '../citations/OpenAlexCitations'
import type { EmbeddingRuntime } from '../embeddings/EmbeddingRuntime'
import { PdfjsExtractor, type PdfExtractor } from '../extract/PdfExtractor'
import { HttpClient, type FetchFn } from '../ingest/http'
import { MetadataResolver } from '../ingest/MetadataResolver'
import { JobQueue } from '../jobs/JobQueue'
import { BudgetGuard, limitsFromConfig } from '../llm/BudgetGuard'
import { ClaudeCliProvider } from '../llm/ClaudeCliProvider'
import { CostLedger } from '../llm/CostLedger'
import type { LlmProvider } from '../llm/LlmProvider'
import { MapService } from '../map/MapService'
import { startLibraryMcpServer } from '../mcp/LibraryMcpServer'
import { libraryTools } from '../mcp/libraryTools'
import { ProjectStore } from '../project/ProjectStore'
import { PAPER_FOLDER, watchProject } from '../project/watcher'
import { interleaveReview } from '../relations/relationMerge'
import { RelationService } from '../relations/RelationService'
import { RelationSuggester } from '../relations/RelationSuggester'
import { SimilarityService } from '../relations/SimilarityService'
import { Summarizer } from '../summary/Summarizer'
import { SummaryService } from '../summary/SummaryService'
import { DEFAULT_DEVICE_ID, LibraryService } from './LibraryService'

export interface SessionOptions {
  contactEmail: string
  /** Sent only to api.openalex.org. */
  openalexApiKey?: string
  fetch?: FetchFn
  extractor?: PdfExtractor
  /** Defaults to true; tests turn it off. */
  watch?: boolean
  /** Names this device's cost log (costs/<device-id>.jsonl). */
  deviceId?: string
  /** Defaults to the Claude CLI; tests pass a fake. */
  llm?: LlmProvider
  /** The local embedding model; null (the default) means similarity uses citations and facets only. */
  embeddings?: EmbeddingRuntime | null
  /** Pause before each OpenAlex request of a citations job; tests pass 0. */
  citationPauseMs?: number
}

type SessionEvent = 'library' | 'jobs' | 'project'

/** Files whose external change alters the bibliography (paper.yaml, or the paper folder appearing or going away). */
const BIB_FILES = new Set(['paper.yaml', PAPER_FOLDER])

/** Everything that lives while one project is open. */
export class ProjectSession {
  private readonly listeners: Record<SessionEvent, Set<() => void>> = { library: new Set(), jobs: new Set(), project: new Set() }
  private stopWatching: (() => void) | null = null
  private readonly inFlight = new Set<Promise<unknown>>()

  private constructor(
    readonly store: ProjectStore,
    readonly cache: IndexCache,
    readonly http: HttpClient,
    readonly library: LibraryService,
    readonly queue: JobQueue,
    readonly summaries: SummaryService,
    readonly citations: CitationService,
    readonly similarity: SimilarityService,
    readonly map: MapService,
    readonly relations: RelationService
  ) {}

  static async create(root: string, name: string, opts: SessionOptions): Promise<ProjectSession> {
    return ProjectSession.start(await ProjectStore.create(root, name), opts)
  }

  static async open(root: string, opts: SessionOptions): Promise<ProjectSession> {
    return ProjectSession.start(await ProjectStore.open(root), opts)
  }

  private static async start(store: ProjectStore, opts: SessionOptions): Promise<ProjectSession> {
    const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
    const http = new HttpClient({ fetch: opts.fetch, contactEmail: opts.contactEmail, openalexApiKey: opts.openalexApiKey })
    // An empty id (settings not loaded yet) counts as none.
    const deviceId = opts.deviceId || DEFAULT_DEVICE_ID
    const library = new LibraryService({
      store,
      cache,
      resolver: new MetadataResolver(http),
      http,
      extractor: opts.extractor ?? new PdfjsExtractor(),
      // trashed.yaml names the same device as the cost log.
      deviceId,
      // Called later, once the queue and the relations service below exist.
      cancelJobs: (ids) => queue.cancelPapers(ids),
      cancelQueued: (ids) => queue.cancelQueuedPapers(ids),
      relations: {
        countTouching: (ids) => relations.countTouching(ids),
        removeTouching: (ids) => relations.removeTouching(ids),
        rekey: (from, to) => relations.rekey(from, to)
      }
    })
    const ledger = new CostLedger(store, deviceId)
    // Agent runs cost more than a summary: their estimate starts higher and grows on its own.
    const budget = new BudgetGuard(
      () => limitsFromConfig(store.config.llm),
      () => ledger.monthTotal(),
      0.05,
      { suggest_relations: 0.25 }
    )
    const llm = opts.llm ?? new ClaudeCliProvider()
    const summarizer = new Summarizer({ store, cache, provider: llm, budget, ledger })
    // The handler reads the services when a job runs: the queue has to exist before them.
    // One analysis at a time: skipping pairs already analyzed from the other paper relies on runs being sequential.
    const queue = new JobQueue(cache, (spec, signal, report) => runJob(session.services(), spec, signal, report), {
      total: 4,
      byType: { summarize: 1, citations: 1, cited_by: 1, embed: 1, model_download: 1, suggest_relations: 1 }
    })
    const summaries = new SummaryService({
      store,
      cache,
      summarizer,
      budget,
      ledger,
      reindex: (id) => library.indexPaper(id),
      emit: () => session.emit('library'),
      enqueue: (spec) => queue.enqueue(spec),
      cancelBatch: (batchId) => queue.cancelBatch(batchId),
      // A form change re-indexes the facets of every paper, which feed the neighbours.
      statesRefreshed: () => void session.track(similarity.recomputeIfChanged()).catch((error) => console.error('similarity', error))
    })
    const citations = new CitationService({
      store,
      cache,
      openalex: new OpenAlexCitations(http),
      reindex: (id) => library.indexPaper(id),
      emit: () => session.emit('library'),
      enqueue: (spec) => queue.enqueue(spec),
      cancelQueued: (types) => queue.cancelTypes(types),
      pauseMs: opts.citationPauseMs
    })
    const similarity = new SimilarityService({
      store,
      cache,
      runtime: opts.embeddings ?? null,
      enqueue: (spec) => queue.enqueue(spec),
      cancelQueued: (types) => queue.cancelTypes(types),
      emit: () => session.emit('library')
    })
    const map = new MapService({ store, cache })
    const suggester = new RelationSuggester({
      store,
      cache,
      provider: llm,
      budget,
      ledger,
      // A fresh read-only MCP server per agent run, closed when the run ends.
      startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: opts.embeddings ?? null }), o)
    })
    const relations = new RelationService({
      store,
      cache,
      suggester,
      budget,
      emit: () => session.emit('library'),
      jobsChanged: () => session.emit('jobs'),
      enqueue: (spec) => queue.enqueue(spec),
      cancelBatch: (batchId) => queue.cancelBatch(batchId)
    })
    const session: ProjectSession = new ProjectSession(store, cache, http, library, queue, summaries, citations, similarity, map, relations)
    await library.reindexAll()
    await relations.reindex()
    library.onChange(() => session.emit('library'))
    queue.onChange(() => session.emit('jobs'))
    queue.start()
    // Vectors and neighbours live in the rebuildable cache: bring them up to date in the background.
    void session.track(similarity.enqueueStale().then(() => similarity.requestRecompute())).catch((error) => console.error('similarity', error))
    if (opts.watch !== false) {
      session.stopWatching = watchProject(store.root, {
        onPaper: (id, files) => {
          // notes.md does not feed the index or the bibliography; the event still lets an open editor pick up an external edit.
          const reindex = [...files].some((f) => f !== 'notes.md')
          const reexport = [...files].some((f) => BIB_FILES.has(f))
          void session
            .track(
              (async () => {
                if (reindex) await library.indexPaper(id)
                if (reexport) await library.exportBib()
                session.emit('library')
                if (reindex) {
                  await similarity.enqueueStale([id])
                  // A no-op when the paper's references, facets and vector did not change (e.g. our own writes).
                  await similarity.paperChanged(id)
                }
              })()
            )
            .catch((error) => console.error('reindex', id, error))
        },
        onConfig: () => {
          void session.track(session.reloadConfig()).catch((error) => console.error('project.yaml', error))
        },
        onRelations: () => {
          // Our own writes come through the watcher too and are already indexed: only a real external change reindexes.
          void session
            .track(
              relations.reindexIfChanged().then((changed) => {
                if (changed) session.emit('library')
              })
            )
            .catch((error) => console.error('relations.yaml', error))
        },
        onTrash: () => {
          void session
            .track(library.syncTrash().then(() => session.emit('library')))
            .catch((error) => console.error('trash', error))
        }
      })
    }
    return session
  }

  on(event: SessionEvent, listener: () => void): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  /** Registers work outside the job queue that uses the cache, so `close()` waits for it. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise)
    const done = (): void => void this.inFlight.delete(promise)
    promise.then(done, done)
    return promise
  }

  /** Picks up an edit of project.yaml made outside the app; the form, the thesis or max_input_chars may change every summary state. */
  async reloadConfig(): Promise<void> {
    // Our own writes come through the watcher too; only a real external change needs the states recomputed.
    if (await this.store.reloadConfig()) await this.summaries.refreshStates()
    this.emit('project')
  }

  services(): JobServices {
    return { library: this.library, summaries: this.summaries, citations: this.citations, similarity: this.similarity, relations: this.relations }
  }

  /** Summary entries and suggested relations still to review, paper by paper (in `ids` order when given, otherwise in list order). */
  async reviewQueue(ids?: string[]): Promise<ReviewItem[]> {
    const unique = ids ? [...new Set(ids)] : undefined
    const rows = unique ? unique.flatMap((id) => this.cache.getPaper(id) ?? []) : this.cache.listPapers()
    const summary = await this.summaries.reviewQueue(unique)
    return interleaveReview(
      rows.map((r) => r.id),
      summary,
      this.relations.reviewItems(rows)
    )
  }

  readPdf(id: string): Promise<Uint8Array | null> {
    return this.track(this.library.readPdf(id))
  }

  detail(id: string): Promise<PaperDetail> {
    return this.track(this.library.detail(id))
  }

  /** «Quitar de la biblioteca»; the neighbours of the moved papers are updated afterwards. */
  async trash(ids: string[]): Promise<TrashOutcome> {
    const outcome = await this.track(this.library.trash(ids))
    for (const id of outcome.moved) await this.track(this.similarity.paperChanged(id)).catch(logged('neighbours'))
    return outcome
  }

  /** «Restaurar» or «Fusionar»; restored papers get their vector (if it changed) and neighbours back. */
  async restore(ids: string[], opts: { merge: boolean }): Promise<RestoreOutcome> {
    const outcome = await this.track(this.library.restore(ids, opts))
    // Where each paper now is: its own key, a free one, or the library paper it was merged into.
    const keys = [...new Set(outcome.restored.map((r) => r.key))]
    if (keys.length > 0) {
      await this.track(this.similarity.enqueueStale(keys)).catch(logged('embeddings'))
      for (const key of keys) await this.track(this.similarity.paperChanged(key)).catch(logged('neighbours'))
    }
    return outcome
  }

  listTrash(): Promise<TrashEntry[]> {
    return this.track(this.library.listTrash())
  }

  deletePlan(target: TrashTarget): Promise<DeletePlan> {
    return this.track(this.library.deletePlan(target))
  }

  /** Exactly the ids a confirmation showed (from deletePlan). */
  deleteForever(ids: string[]): Promise<number> {
    return this.track(this.library.deleteForever(ids))
  }

  async close(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = null
    await this.queue.stop()
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
    this.cache.close()
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners[event]) listener()
  }
}

export interface JobServices {
  library: LibraryService
  summaries: SummaryService
  citations: CitationService
  similarity: SimilarityService
  relations: RelationService
}

const logged =
  (what: string) =>
  (error: unknown): void =>
    console.error(what, error)

export async function runJob(
  s: JobServices,
  spec: JobSpec,
  signal: AbortSignal,
  report: (progress: number) => void = () => undefined
): Promise<{ paperId?: string; message?: string }> {
  switch (spec.type) {
    case 'summarize': {
      const result = await s.summaries.run(spec.paperId, { force: spec.force, batchId: spec.batchId, model: spec.model, signal })
      // Problem, contribution and method feed the embedding input; the facets feed the similarity directly.
      await s.similarity.enqueueStale([spec.paperId]).catch(logged('embeddings'))
      await s.similarity.paperChanged(spec.paperId).catch(logged('neighbours'))
      await s.relations.autoAfter(spec.paperId).catch(logged('auto relations'))
      return result
    }
    case 'citations': {
      let result: { paperId?: string; message?: string }
      try {
        result = await s.citations.fetch(spec.paperId, signal)
      } finally {
        if (!signal.aborted) await s.similarity.afterJob(spec.paperId).catch(logged('neighbours'))
      }
      // After the neighbours are updated, so the candidates it looks at are current.
      await s.relations.autoAfter(spec.paperId).catch(logged('auto relations'))
      return result
    }
    case 'cited_by':
      return s.citations.fetchCitedBy(spec.paperId, signal)
    case 'embed': {
      let result: { paperId?: string; message?: string }
      try {
        result = await s.similarity.embed(spec.paperId, signal)
      } finally {
        if (!signal.aborted) await s.similarity.afterJob(spec.paperId).catch(logged('neighbours'))
      }
      await s.relations.autoAfter(spec.paperId).catch(logged('auto relations'))
      return result
    }
    case 'model_download':
      return s.similarity.downloadModel(signal, report)
    case 'suggest_relations':
      return s.relations.run(spec.paperId, { force: spec.force, batchId: spec.batchId, model: spec.model, signal })
    case 'attach_pdf': {
      // Only the PDF and its text change: summaries, citations and embeddings stay as they are.
      const outcome = await s.library.attachPdf(spec.paperId, spec.path, { replace: spec.replace }, signal)
      return { paperId: outcome.paperId, message: outcome.status }
    }
    case 'ingest_identifier':
    case 'ingest_pdf':
    case 'update_metadata': {
      const outcome =
        spec.type === 'ingest_identifier'
          ? await s.library.ingestIdentifier(spec.input, signal)
          : spec.type === 'ingest_pdf'
            ? await s.library.ingestPdf(spec.path, signal)
            : await s.library.updateMetadata(spec.paperId, spec.input, signal)
      if (outcome.status !== 'duplicate') {
        await s.summaries.autoAfterIngest(outcome.paperId).catch(logged('auto summarize'))
        try {
          s.citations.autoAfterIngest(outcome.paperId)
        } catch (error) {
          logged('auto citations')(error)
        }
        await s.similarity.enqueueStale([outcome.paperId]).catch(logged('embeddings'))
      }
      return { paperId: outcome.paperId, message: outcome.status }
    }
  }
}
