import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
import { IndexCache } from '../cache/IndexCache'
import { PdfjsExtractor, type PdfExtractor } from '../extract/PdfExtractor'
import { HttpClient, type FetchFn } from '../ingest/http'
import { MetadataResolver } from '../ingest/MetadataResolver'
import { JobQueue } from '../jobs/JobQueue'
import { BudgetGuard, limitsFromConfig } from '../llm/BudgetGuard'
import { ClaudeCliProvider } from '../llm/ClaudeCliProvider'
import { CostLedger } from '../llm/CostLedger'
import type { LlmProvider } from '../llm/LlmProvider'
import { ProjectStore } from '../project/ProjectStore'
import { PAPER_FOLDER, watchProject } from '../project/watcher'
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
    readonly summaries: SummaryService
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
    // The handler reads `session.summaries` when a job runs: the queue has to exist before the service.
    const queue = new JobQueue(cache, (spec, signal) => runJob(library, session.summaries, spec, signal), { total: 3, byType: { summarize: 1 } })
    const summaries = new SummaryService({
      store,
      cache,
      summarizer,
      budget,
      ledger,
      reindex: (id) => library.indexPaper(id),
      emit: () => session.emit('library'),
      enqueue: (spec) => queue.enqueue(spec),
      cancelBatch: (batchId) => queue.cancelBatch(batchId)
    })
    const session: ProjectSession = new ProjectSession(store, cache, http, library, queue, summaries)
    await library.reindexAll()
    library.onChange(() => session.emit('library'))
    queue.onChange(() => session.emit('jobs'))
    queue.start()
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

export async function runJob(library: LibraryService, summaries: SummaryService, spec: JobSpec, signal: AbortSignal): Promise<{ paperId?: string; message?: string }> {
  switch (spec.type) {
    case 'summarize':
      return summaries.run(spec.paperId, { force: spec.force, batchId: spec.batchId, model: spec.model, signal })
    case 'ingest_identifier':
    case 'ingest_pdf':
    case 'update_metadata': {
      const outcome =
        spec.type === 'ingest_identifier'
          ? await library.ingestIdentifier(spec.input, signal)
          : spec.type === 'ingest_pdf'
            ? await library.ingestPdf(spec.path, signal)
            : await library.updateMetadata(spec.paperId, spec.input, signal)
      if (outcome.status !== 'duplicate') await summaries.autoAfterIngest(outcome.paperId).catch((error) => console.error('auto summarize', error))
      return { paperId: outcome.paperId, message: outcome.status }
    }
    default:
      throw new Error(`No handler for ${spec.type} jobs`)
  }
}
