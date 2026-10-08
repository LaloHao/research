import { join } from 'node:path'
import type { JobSpec } from '../../shared/jobs'
import { IndexCache } from '../cache/IndexCache'
import { PdfjsExtractor, type PdfExtractor } from '../extract/PdfExtractor'
import { HttpClient, type FetchFn } from '../ingest/http'
import { MetadataResolver } from '../ingest/MetadataResolver'
import { JobQueue } from '../jobs/JobQueue'
import { ProjectStore } from '../project/ProjectStore'
import { watchProject } from '../project/watcher'
import { LibraryService } from './LibraryService'

export interface SessionOptions {
  contactEmail: string
  fetch?: FetchFn
  extractor?: PdfExtractor
  /** Defaults to true; tests turn it off. */
  watch?: boolean
}

type SessionEvent = 'library' | 'jobs'

/** Everything that lives while one project is open. */
export class ProjectSession {
  private readonly listeners: Record<SessionEvent, Set<() => void>> = { library: new Set(), jobs: new Set() }
  private stopWatching: (() => void) | null = null

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
        onPaper: (id) => {
          library
            .indexPaper(id)
            .then(() => library.exportBib())
            .then(() => session.emit('library'))
            .catch((error) => console.error('reindex', id, error))
        },
        onConfig: () => {
          store
            .reloadConfig()
            .then(() => session.emit('library'))
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

  async close(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = null
    await this.queue.stop()
    this.cache.close()
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners[event]) listener()
  }
}

export async function runJob(library: LibraryService, spec: JobSpec, signal: AbortSignal): Promise<{ paperId?: string; message?: string }> {
  const outcome =
    spec.type === 'ingest_identifier'
      ? await library.ingestIdentifier(spec.input, signal)
      : spec.type === 'ingest_pdf'
        ? await library.ingestPdf(spec.path, signal)
        : await library.updateMetadata(spec.paperId, spec.input, signal)
  return { paperId: outcome.paperId, message: outcome.status }
}
