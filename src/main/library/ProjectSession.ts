import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
import { IndexCache } from '../cache/IndexCache'
import { PdfjsExtractor, type PdfExtractor } from '../extract/PdfExtractor'
import { HttpClient, type FetchFn } from '../ingest/http'
import { MetadataResolver } from '../ingest/MetadataResolver'
import { JobQueue } from '../jobs/JobQueue'
import { ProjectStore } from '../project/ProjectStore'
import { PAPER_FOLDER, watchProject } from '../project/watcher'
import { LibraryService } from './LibraryService'

export interface SessionOptions {
  contactEmail: string
  fetch?: FetchFn
  extractor?: PdfExtractor
  /** Defaults to true; tests turn it off. */
  watch?: boolean
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
    readonly queue: JobQueue
  ) {}

  static async create(root: string, name: string, opts: SessionOptions): Promise<ProjectSession> {
    return ProjectSession.start(await ProjectStore.create(root, name), opts)
  }

  static async open(root: string, opts: SessionOptions): Promise<ProjectSession> {
    return ProjectSession.start(await ProjectStore.open(root), opts)
  }

  private static async start(store: ProjectStore, opts: SessionOptions): Promise<ProjectSession> {
    const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
    const http = new HttpClient({ fetch: opts.fetch, contactEmail: opts.contactEmail })
    const library = new LibraryService({ store, cache, resolver: new MetadataResolver(http), http, extractor: opts.extractor ?? new PdfjsExtractor() })
    const queue = new JobQueue(cache, (spec, signal) => runJob(library, spec, signal))
    const session = new ProjectSession(store, cache, http, library, queue)
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
          void session
            .track(store.reloadConfig().then(() => session.emit('project')))
            .catch((error) => console.error('project.yaml', error))
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

export async function runJob(library: LibraryService, spec: JobSpec, signal: AbortSignal): Promise<{ paperId?: string; message?: string }> {
  if (spec.type === 'summarize') throw new Error('summarize jobs are not implemented yet')
  const outcome =
    spec.type === 'ingest_identifier'
      ? await library.ingestIdentifier(spec.input, signal)
      : spec.type === 'ingest_pdf'
        ? await library.ingestPdf(spec.path, signal)
        : await library.updateMetadata(spec.paperId, spec.input, signal)
  return { paperId: outcome.paperId, message: outcome.status }
}
