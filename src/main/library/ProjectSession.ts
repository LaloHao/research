import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
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
import { ProjectStore } from '../project/ProjectStore'
import { PAPER_FOLDER, watchProject } from '../project/watcher'
import { SimilarityService } from '../relations/SimilarityService'
import { Summarizer } from '../summary/Summarizer'
import { SummaryService } from '../summary/SummaryService'
import { LibraryService } from './LibraryService'

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

const DEFAULT_DEVICE_ID = '00000000-0000-0000-0000-000000000000'

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
    readonly map: MapService
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
    const library = new LibraryService({ store, cache, resolver: new MetadataResolver(http), http, extractor: opts.extractor ?? new PdfjsExtractor() })
    const ledger = new CostLedger(store, opts.deviceId ?? DEFAULT_DEVICE_ID)
    const budget = new BudgetGuard(
      () => limitsFromConfig(store.config.llm),
      () => ledger.monthTotal()
    )
    const summarizer = new Summarizer({ store, cache, provider: opts.llm ?? new ClaudeCliProvider(), budget, ledger })
    // The handler reads the services when a job runs: the queue has to exist before them.
    const queue = new JobQueue(cache, (spec, signal, report) => runJob(session.services(), spec, signal, report), {
      total: 4,
      byType: { summarize: 1, citations: 1, cited_by: 1, embed: 1, model_download: 1 }
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
    const session: ProjectSession = new ProjectSession(store, cache, http, library, queue, summaries, citations, similarity, new MapService({ store, cache }))
    await library.reindexAll()
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
    return { library: this.library, summaries: this.summaries, citations: this.citations, similarity: this.similarity }
  }

  readPdf(id: string): Promise<Uint8Array | null> {
    return this.track(this.library.readPdf(id))
  }

  detail(id: string): Promise<PaperDetail> {
    return this.track(this.library.detail(id))
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
      return result
    }
    case 'citations':
      try {
        return await s.citations.fetch(spec.paperId, signal)
      } finally {
        if (!signal.aborted) await s.similarity.afterJob(spec.paperId).catch(logged('neighbours'))
      }
    case 'cited_by':
      return s.citations.fetchCitedBy(spec.paperId, signal)
    case 'embed':
      try {
        return await s.similarity.embed(spec.paperId, signal)
      } finally {
        if (!signal.aborted) await s.similarity.afterJob(spec.paperId).catch(logged('neighbours'))
      }
    case 'model_download':
      return s.similarity.downloadModel(signal, report)
    case 'suggest_relations':
      throw new Error('No handler for suggest_relations jobs')
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
