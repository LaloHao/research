import { hostname } from 'node:os'
import { join } from 'node:path'
import type { ChatStreamUpdate } from '../../shared/chat'
import type { JobSpec } from '../../shared/jobs'
import type { PaperDetail } from '../../shared/library'
import type { ReviewItem } from '../../shared/summary'
import type { DeletePlan, RestoreOutcome, TrashEntry, TrashOutcome, TrashTarget } from '../../shared/trash'
import { IndexCache } from '../cache/IndexCache'
import { ChatActions } from '../chats/ChatActions'
import { ChatService } from '../chats/ChatService'
import { CitationService } from '../citations/CitationService'
import { OpenAlexCitations } from '../citations/OpenAlexCitations'
import type { EmbeddingRuntime } from '../embeddings/EmbeddingRuntime'
import { PdfjsExtractor, type PdfExtractor } from '../extract/PdfExtractor'
import { FacetSuggester } from '../facets/FacetSuggester'
import { FacetSuggestionService } from '../facets/FacetSuggestionService'
import { HttpClient, type FetchFn } from '../ingest/http'
import { MetadataResolver } from '../ingest/MetadataResolver'
import { JobQueue } from '../jobs/JobQueue'
import { BudgetGuard, limitsFromConfig } from '../llm/BudgetGuard'
import { ClaudeCliProvider } from '../llm/ClaudeCliProvider'
import { CostLedger } from '../llm/CostLedger'
import type { LlmProvider } from '../llm/LlmProvider'
import { MapService } from '../map/MapService'
import { MappingService } from '../mapping/MappingService'
import { OpenAlexSearch } from '../mapping/OpenAlexSearch'
import { ScreeningSuggester } from '../mapping/ScreeningSuggester'
import { startActionsMcpServer } from '../mcp/ActionsMcpServer'
import { startLibraryMcpServer } from '../mcp/LibraryMcpServer'
import { libraryTools } from '../mcp/libraryTools'
import { ProjectStore } from '../project/ProjectStore'
import { PAPER_FOLDER, watchProject } from '../project/watcher'
import { interleaveReview } from '../relations/relationMerge'
import { RelationService } from '../relations/RelationService'
import { RelationSuggester } from '../relations/RelationSuggester'
import { SimilarityService } from '../relations/SimilarityService'
import { FacetFiller } from '../summary/FacetFiller'
import { Summarizer } from '../summary/Summarizer'
import { SummaryService } from '../summary/SummaryService'
import { SyncScheduler } from '../sync/SyncScheduler'
import { machineName } from '../sync/messages'
import { SyncService } from '../sync/SyncService'
import { WritingService } from '../writing/WritingService'
import { DEFAULT_DEVICE_ID, LibraryService } from './LibraryService'

/** The per-device automatic sync settings, read at every tick. */
export interface AutoSyncOptions {
  enabled: () => boolean
  intervalMs: () => number
}

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
  /** The automatic git sync; absent or null: the project syncs only when asked. */
  autoSync?: AutoSyncOptions | null
  /** Extra environment for git (tests isolate it from the user's git config). */
  gitEnv?: Record<string, string>
  /** Names this machine in sync commits; defaults to the host name. */
  machineName?: string
  /** The clock of the facet suggestions (their automatic trigger runs at most once a day) and of the mappings; tests pass their own. */
  now?: () => Date
}

type SessionEvent = 'library' | 'jobs' | 'project' | 'sync' | 'facets' | 'chats' | 'mappings'

/** Files whose external change alters the bibliography (paper.yaml, or the paper folder appearing or going away). */
const BIB_FILES = new Set(['paper.yaml', PAPER_FOLDER])

/** Everything that lives while one project is open. */
export class ProjectSession {
  private readonly listeners: Record<SessionEvent, Set<() => void>> = { library: new Set(), jobs: new Set(), project: new Set(), sync: new Set(), facets: new Set(), chats: new Set(), mappings: new Set() }
  private readonly streamListeners = new Set<(u: ChatStreamUpdate) => void>()
  private stopWatching: (() => void) | null = null
  private readonly inFlight = new Set<Promise<unknown>>()
  private scheduler: SyncScheduler | null = null
  /** Trash operations in flight: they move whole folders, so the automatic sync waits for the next tick. */
  private trashOps = 0

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
    readonly relations: RelationService,
    readonly sync: SyncService,
    readonly facets: FacetSuggestionService,
    readonly chats: ChatService,
    readonly mappings: MappingService,
    readonly writing: WritingService
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
      { suggest_relations: 0.25, suggest_facets: 0.5, chat: 0.1, screening: 0.1, draft: 0.2, cite_check: 0.2, outline: 0.1, style: 0.1 }
    )
    const llm = opts.llm ?? new ClaudeCliProvider()
    const summarizer = new Summarizer({ store, cache, provider: llm, budget, ledger })
    const filler = new FacetFiller({ store, cache, provider: llm, budget, ledger })
    // The handler reads the services when a job runs: the queue has to exist before them.
    // One analysis at a time: skipping pairs already analyzed from the other paper relies on runs being sequential.
    const queue = new JobQueue(cache, (spec, signal, report) => runJob(session.services(), spec, signal, report), {
      total: 4,
      byType: {
        summarize: 1,
        citations: 1,
        cited_by: 1,
        embed: 1,
        model_download: 1,
        suggest_relations: 1,
        fill_facets: 1,
        suggest_facets: 1,
        mapping_search: 1,
        mapping_snowball: 1,
        screen_suggest: 1,
        ingest_record: 2
      }
    })
    const summaries = new SummaryService({
      store,
      cache,
      summarizer,
      filler,
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
    const sync = new SyncService({
      root: store.root,
      exclusive: (fn) => store.exclusive(fn),
      pdfPolicy: () => store.config.pdfs.policy,
      paperTitle: (key) => cache.getPaper(key)?.title ?? null,
      machineName: opts.machineName,
      gitEnv: opts.gitEnv,
      emit: () => session.emit('sync')
    })
    const facets = new FacetSuggestionService({
      store,
      cache,
      summaries,
      suggester: new FacetSuggester({
        store,
        cache,
        provider: llm,
        budget,
        ledger,
        // A fresh read-only MCP server per agent run, closed when the run ends.
        startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: opts.embeddings ?? null }), o),
        now: opts.now
      }),
      budget,
      emit: () => session.emit('facets'),
      enqueue: (spec) => queue.enqueue(spec),
      // Accepting rewrites project.yaml: the form editor reloads without waiting for the watcher.
      formChanged: () => session.emit('project'),
      now: opts.now
    })
    // The chat's actions go through the same services as the UI's buttons, and the session's own trash operations
    // (tracked, so closing the project waits for them; they update the neighbours and hold off the automatic sync).
    const chatActions = new ChatActions({
      store,
      cache,
      listTrash: () => session.listTrash(),
      deletePlan: (target) => session.deletePlan(target),
      queue,
      summaries,
      relations,
      facets,
      sync,
      estimate: (operation) => budget.currentEstimate(operation),
      trash: (ids) => session.trash(ids),
      restore: (ids, o) => session.restore(ids, o),
      deleteForever: (ids) => session.deleteForever(ids),
      now: opts.now
    })
    const chats = new ChatService({
      store,
      cache,
      provider: llm,
      budget,
      ledger,
      // A fresh read-only MCP server per answer, closed when the answer ends.
      startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: opts.embeddings ?? null }), o),
      // Offered only to an answer of a conversation whose switches are on; a fresh server per answer, closed when it ends.
      actions: chatActions,
      startActions: (o) => startActionsMcpServer(o),
      machine: machineName(opts.machineName ?? hostname()),
      emit: () => session.emit('chats'),
      stream: (u) => session.emitStream(u),
      now: opts.now
    })
    const mappings = new MappingService({
      store,
      cache,
      emit: () => session.emit('mappings'),
      machine: machineName(opts.machineName ?? hostname()),
      now: opts.now,
      library: {
        ingestIdentifier: (input, signal) => library.ingestIdentifier(input, signal),
        ingestMetadata: (meta, signal) => library.ingestMetadata(meta, signal)
      },
      openalex: new OpenAlexSearch(http),
      citations: { fetch: (id, signal) => citations.fetch(id, signal), fetchCitedBy: (id, signal) => citations.fetchCitedBy(id, signal) },
      suggester: new ScreeningSuggester({
        store,
        cache,
        provider: llm,
        budget,
        ledger,
        // Full-text suggestions read the paper with a fresh read-only MCP server per run, closed when it ends.
        startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: opts.embeddings ?? null }), o)
      }),
      costs: { estimate: (op) => budget.currentEstimate(op), limits: () => limitsFromConfig(store.config.llm), monthSpent: () => ledger.monthTotal() },
      enqueue: (spec) => queue.enqueue(spec),
      cancelBatch: (batchId) => queue.cancelBatch(batchId),
      pauseMs: opts.citationPauseMs
    })
    const writing = new WritingService({ store, cache, includedPapers: (id) => mappings.includedPapers(id) })
    const session: ProjectSession = new ProjectSession(store, cache, http, library, queue, summaries, citations, similarity, map, relations, sync, facets, chats, mappings, writing)
    await library.reindexAll()
    await relations.reindex()
    await facets.reindex()
    await chats.reindex()
    await mappings.reindexAll()
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
          // A folder git moved into .trash/: the trash row has to exist before the library row goes, or the cache drops
          // the text, vector and citing works it keeps for a restore (the .trash/ event may come later).
          const trashedHere = files.has(PAPER_FOLDER) && store.trashExists(id)
          void session
            .track(
              (async () => {
                if (trashedHere) await library.syncTrash()
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
        onFacetSuggestions: () => {
          // Our own writes come through the watcher too and are already read: only a real external change counts.
          void session
            .track(
              facets.reindexIfChanged().then((changed) => {
                if (changed) session.emit('facets')
              })
            )
            .catch((error) => console.error('facet-suggestions.yaml', error))
        },
        onChats: () => {
          // Our own writes come through the watcher too and are already indexed: only a real external change counts.
          void session
            .track(
              chats.reindexIfChanged().then((changed) => {
                if (changed) session.emit('chats')
              })
            )
            .catch((error) => console.error('chats', error))
        },
        onMappings: (id) => {
          // Our own writes come through the watcher too and are already indexed: only a real external change counts.
          void session
            .track(
              mappings.reindexIfChanged(id).then((changed) => {
                if (changed) session.emit('mappings')
              })
            )
            .catch((error) => console.error('mappings', id, error))
        },
        onTrash: () => {
          void session
            .track(library.syncTrash().then(() => session.emit('library')))
            .catch((error) => console.error('trash', error))
        }
      })
    }
    if (opts.autoSync) {
      const auto = opts.autoSync
      session.scheduler = new SyncScheduler({
        run: () => sync.run({ auto: true }),
        // Never over a decision waiting for the user, nor while the trash moves folders.
        canRun: () => !sync.hasConflicts && session.trashOps === 0,
        enabled: () => auto.enabled(),
        intervalMs: () => auto.intervalMs()
      })
      session.scheduler.start()
    }
    return session
  }

  on(event: SessionEvent, listener: () => void): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  /** An answer's progress (the window shows it as it arrives). */
  onChatStream(listener: (u: ChatStreamUpdate) => void): () => void {
    this.streamListeners.add(listener)
    return () => this.streamListeners.delete(listener)
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
    return {
      library: this.library,
      summaries: this.summaries,
      citations: this.citations,
      similarity: this.similarity,
      relations: this.relations,
      facets: this.facets,
      mappings: this.mappings
    }
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
  trash(ids: string[]): Promise<TrashOutcome> {
    return this.track(
      this.trashOp(async () => {
        const outcome = await this.library.trash(ids)
        for (const id of outcome.moved) await this.similarity.paperChanged(id).catch(logged('neighbours'))
        return outcome
      })
    )
  }

  /** «Restaurar» or «Fusionar»; restored papers get their vector (if it changed) and neighbours back. */
  restore(ids: string[], opts: { merge: boolean }): Promise<RestoreOutcome> {
    return this.track(
      this.trashOp(async () => {
        const outcome = await this.library.restore(ids, opts)
        // Where each paper now is: its own key, a free one, or the library paper it was merged into.
        const keys = [...new Set(outcome.restored.map((r) => r.key))]
        if (keys.length > 0) {
          await this.similarity.enqueueStale(keys).catch(logged('embeddings'))
          for (const key of keys) await this.similarity.paperChanged(key).catch(logged('neighbours'))
        }
        return outcome
      })
    )
  }

  listTrash(): Promise<TrashEntry[]> {
    return this.track(this.library.listTrash())
  }

  deletePlan(target: TrashTarget): Promise<DeletePlan> {
    return this.track(this.library.deletePlan(target))
  }

  /** Exactly the ids a confirmation showed (from deletePlan). */
  deleteForever(ids: string[]): Promise<number> {
    return this.track(this.trashOp(() => this.library.deleteForever(ids)))
  }

  /** The automatic sync settings changed. */
  rescheduleSync(): void {
    this.scheduler?.reschedule()
  }

  async close(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = null
    // Everything is told to stop at once, before any wait: the scheduler (no new automatic sync), the sync (its git runs
    // in a process group of its own that would outlive the app, so a fetch or push is cut short; a local step, which may
    // hold the store's write gate, is let finish) and the queue (running jobs abort and stay queued for next time).
    // Awaiting the scheduler on its own first would wait for that fetch or push to end by itself.
    // Running answers stop too, saved as stopped (sends in progress finish first), before the cache closes.
    await Promise.all([this.scheduler?.stop(), this.sync.close(), this.queue.stop(), this.chats.close()])
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
    this.cache.close()
  }

  private async trashOp<T>(work: () => Promise<T>): Promise<T> {
    this.trashOps++
    try {
      return await work()
    } finally {
      this.trashOps--
    }
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners[event]) listener()
  }

  /** A listener that throws (a window going away) never breaks the answer or the other listeners. */
  private emitStream(u: ChatStreamUpdate): void {
    for (const listener of this.streamListeners) {
      try {
        listener(u)
      } catch (error) {
        console.error('chat stream', error)
      }
    }
  }
}

export interface JobServices {
  library: LibraryService
  summaries: SummaryService
  citations: CitationService
  similarity: SimilarityService
  relations: RelationService
  facets: FacetSuggestionService
  mappings: MappingService
}

const logged =
  (what: string) =>
  (error: unknown): void =>
    console.error(what, error)

/** What follows any ingest that added or updated a paper: the automatic summary, citations and embedding. */
async function afterIngest(s: JobServices, paperId: string): Promise<void> {
  await s.summaries.autoAfterIngest(paperId).catch(logged('auto summarize'))
  try {
    s.citations.autoAfterIngest(paperId)
  } catch (error) {
    logged('auto citations')(error)
  }
  await s.similarity.enqueueStale([paperId]).catch(logged('embeddings'))
}

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
      await s.facets.autoAfterSummary().catch(logged('auto facets'))
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
    case 'suggest_facets':
      return s.facets.run({ batchId: spec.batchId, model: spec.model, signal })
    case 'fill_facets': {
      const result = await s.summaries.runFill(spec.paperId, { batchId: spec.batchId, signal })
      // New facet values feed the neighbours, like a summary's.
      await s.similarity.paperChanged(spec.paperId).catch(logged('neighbours'))
      return result
    }
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
      if (outcome.status !== 'duplicate') await afterIngest(s, outcome.paperId)
      return { paperId: outcome.paperId, message: outcome.status }
    }
    case 'mapping_search':
      return s.mappings.runSearch(spec, signal)
    case 'mapping_snowball':
      return s.mappings.runSnowball(spec, signal)
    case 'screen_suggest':
      return s.mappings.runSuggestions(spec, signal)
    case 'ingest_record': {
      const outcome = await s.mappings.ingestRecord(spec, signal)
      if (outcome.status !== 'duplicate') await afterIngest(s, outcome.paperId)
      return { paperId: outcome.paperId, message: outcome.status }
    }
  }
}
