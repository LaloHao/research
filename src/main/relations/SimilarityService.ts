import type { JobSpec, JobType } from '../../shared/jobs'
import type { Paper } from '../../shared/schemas'
import type { SummaryFile } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { EmbeddingRuntime } from '../embeddings/EmbeddingRuntime'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { sha256 } from '../project/atomicWrite'
import type { ProjectStore } from '../project/ProjectStore'
import { internalCiters, neighboursOf, updateNeighbours, type PaperSignals, type ScoredPair } from './similarity'

/** A full recompute yields to the event loop every this many rows, so IPC keeps being served. */
const YIELD_EVERY = 50
/** Jobs that make up a batch whose end triggers one full recompute. */
const BATCH_TYPES: JobType[] = ['embed', 'citations']
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** The text a paper's vector is made from; when its hash changes (summary, edited abstract…) the vector is redone. */
export function embeddingInput(paper: Paper, summary: SummaryFile | null): string {
  const parts = [paper.title, paper.abstract ?? '']
  if (summary) parts.push(summary.fields.problem.value, summary.fields.contribution.value, summary.fields.method.value)
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Everything a paper's neighbours depend on. Equal signatures: nothing to update (e.g. our own paper.yaml write). */
export function signalSignature(p: PaperSignals): string {
  const facets = [...p.facets].map(([key, values]) => [key, [...values].sort()] as const).sort(([x], [y]) => x.localeCompare(y))
  const text = JSON.stringify({ openalex: p.openalexId, references: [...p.references].sort(), facets })
  const vector = p.vector ? sha256(new Uint8Array(p.vector.buffer, p.vector.byteOffset, p.vector.byteLength)) : ''
  return `${sha256(text)}:${vector}`
}

export interface SimilarityServiceDeps {
  store: ProjectStore
  cache: IndexCache
  /** null when this build has no local model runtime: similarity then uses citations and facets only. */
  runtime: EmbeddingRuntime | null
  enqueue: (spec: JobSpec) => number
  cancelQueued: (types: JobType[]) => number
  emit: () => void
}

/** Vectors (embed jobs), the local model (model_download job) and the stored neighbours of every paper. */
export class SimilarityService {
  private running: Promise<void> | null = null
  private rerun = false
  /** A recompute was skipped because a batch was queued: the batch's last job runs it. */
  private batchPending = false
  /** Each paper's signals and signature as of the last update; null until the first full recompute. */
  private snapshot: Map<string, { signals: PaperSignals; signature: string }> | null = null
  private incremental: Promise<void> = Promise.resolve()
  /** Bumped when the model is removed: an embedding started before must not store its vector afterwards. */
  private modelGeneration = 0

  constructor(private readonly deps: SimilarityServiceDeps) {}

  async embed(paperId: string, signal?: AbortSignal): Promise<{ paperId: string; message: 'embedded' }> {
    const generation = this.modelGeneration
    try {
      const embedder = (await this.deps.runtime?.embedder()) ?? null
      if (!embedder) throw new UserFacingError('model_missing')
      const input = await this.input(paperId)
      if (!input) throw new UserFacingError('file_problem')
      const [vector] = await embedder.embed([input.text], 'passage', signal)
      signal?.throwIfAborted()
      if (generation !== this.modelGeneration) throw new UserFacingError('model_missing')
      this.deps.cache.setVector(paperId, input.hash, embedder.modelId, vector)
      // enqueueStale skipped this paper while its job ran: an input edited meanwhile needs another pass.
      const latest = await this.input(paperId)
      if (latest && latest.hash !== input.hash) this.deps.enqueue({ type: 'embed', paperId })
      return { paperId, message: 'embedded' }
    } catch (error) {
      if (signal?.aborted) throw error
      throw toUserFacing(error)
    }
  }

  /** Queues an embed job for every paper whose input or model changed. Nothing while the model is not on disk. */
  async enqueueStale(ids?: string[]): Promise<number> {
    const { runtime, cache, store } = this.deps
    if (!runtime || (await runtime.status()).state !== 'ready') return 0
    let count = 0
    for (const id of ids ?? cache.paperIds()) {
      if (!store.paperExists(id) || cache.hasActiveJob('embed', id)) continue
      const input = await this.input(id)
      if (!input) continue
      const meta = cache.vectorMeta(id)
      if (meta && meta.inputHash === input.hash && meta.model === runtime.modelId) continue
      this.deps.enqueue({ type: 'embed', paperId: id })
      count++
    }
    return count
  }

  /**
   * Full recompute, for the end of a batch and for opening the project (the cache may have been rebuilt). While embed
   * or citations jobs are queued it is left to the last of them. Calls made while one runs share one rerun.
   */
  requestRecompute(): Promise<void> {
    if (this.deps.cache.hasQueuedJobs(BATCH_TYPES)) {
      this.batchPending = true
      return Promise.resolve()
    }
    this.batchPending = false
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rerun = false
        await this.recompute()
      } while (this.rerun)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** After an embed or citations job: a batch ends with one full recompute; a lone job updates its paper only. */
  afterJob(paperId: string): Promise<void> {
    if (this.batchPending || !this.snapshot || this.deps.cache.hasQueuedJobs(BATCH_TYPES)) return this.requestRecompute()
    return this.paperChanged(paperId)
  }

  /**
   * After a re-index that may touch many papers at once (e.g. the extraction form changed every paper's facets):
   * a full recompute, skipped when no paper's signals differ from the last update.
   */
  recomputeIfChanged(): Promise<void> {
    const snapshot = this.snapshot
    if (snapshot && !this.running) {
      const papers = this.signals()
      if (papers.length === snapshot.size && papers.every((p) => snapshot.get(p.id)?.signature === signalSignature(p))) return Promise.resolve()
    }
    return this.requestRecompute()
  }

  /** One paper changed, appeared or disappeared (a lone job, an edit outside the app). Updates run one at a time. */
  paperChanged(paperId: string): Promise<void> {
    const run = this.incremental.then(() => this.updateOne(paperId))
    this.incremental = run.catch(() => undefined)
    return run
  }

  /** Every row from scratch, yielding regularly so a large library does not block IPC. */
  private async recompute(): Promise<void> {
    const papers = this.signals()
    const citers = internalCiters(papers)
    const rows: ScoredPair[] = []
    for (let i = 0; i < papers.length; i++) {
      rows.push(...neighboursOf(papers[i], papers, citers))
      if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop()
    }
    this.deps.cache.replaceSimilar(rows)
    this.snapshot = new Map(papers.map((p) => [p.id, { signals: p, signature: signalSignature(p) }]))
    this.deps.emit()
  }

  /** Everything the similarity of a pair is computed from, for every readable paper. */
  signals(): PaperSignals[] {
    const { cache, runtime } = this.deps
    const vectors = runtime ? cache.vectors(runtime.modelId) : new Map<string, Float32Array>()
    const references = new Map<string, Set<string>>()
    for (const e of cache.citationEdges()) references.set(e.citing, (references.get(e.citing) ?? new Set()).add(e.cited))
    const facets = new Map<string, Map<string, Set<string>>>()
    for (const r of cache.facetRows()) {
      const byFacet = facets.get(r.paperId) ?? new Map<string, Set<string>>()
      byFacet.set(r.facet, (byFacet.get(r.facet) ?? new Set()).add(r.value))
      facets.set(r.paperId, byFacet)
    }
    return cache.relationRows().map((r) => ({
      id: r.id,
      openalexId: r.openalex_id,
      references: references.get(r.id) ?? new Set(),
      facets: facets.get(r.id) ?? new Map(),
      vector: vectors.get(r.id) ?? null
    }))
  }

  async requestModelDownload(): Promise<void> {
    if (!this.deps.runtime) throw new UserFacingError('model_missing')
    if (this.deps.cache.hasActiveJobOfType('model_download')) return
    this.deps.enqueue({ type: 'model_download' })
  }

  async downloadModel(signal: AbortSignal, report: (fraction: number) => void): Promise<{ message: 'model_downloaded' }> {
    const runtime = this.deps.runtime
    if (!runtime) throw new UserFacingError('model_missing')
    try {
      await runtime.download(report, signal)
    } catch (error) {
      if (signal.aborted) throw error
      throw toUserFacing(error)
    }
    await this.enqueueStale()
    return { message: 'model_downloaded' }
  }

  /** Deletes the model files; similarity falls back to citations and facets. */
  async removeModel(): Promise<void> {
    this.modelGeneration++
    // Queued embeddings would only fail with model_missing.
    this.deps.cancelQueued(['embed'])
    await this.deps.runtime?.remove()
    this.deps.cache.clearVectors()
    await this.requestRecompute()
  }

  private async updateOne(paperId: string): Promise<void> {
    if (this.running) await this.running
    if (!this.snapshot) return this.requestRecompute()
    const { cache } = this.deps
    if (cache.hasQueuedJobs(BATCH_TYPES)) {
      // The batch's last job recomputes everything, this paper included.
      this.batchPending = true
      return
    }
    if (this.batchPending) {
      // A batch job still running will recompute in its afterJob. Otherwise the batch ended without one (its last job
      // aborted, or the rest cancelled while queued): recompute now, or every later change would wait forever.
      if (BATCH_TYPES.some((type) => cache.hasActiveJobOfType(type))) return
      return this.requestRecompute()
    }
    const papers = this.signals()
    const current = papers.find((p) => p.id === paperId) ?? null
    const before = this.snapshot.get(paperId) ?? null
    const signature = current ? signalSignature(current) : null
    if ((before?.signature ?? null) === signature) return
    const rows = new Map<string, ScoredPair[]>()
    for (const pair of this.deps.cache.allSimilar()) rows.set(pair.a, [...(rows.get(pair.a) ?? []), pair])
    this.deps.cache.setSimilarRows(updateNeighbours(papers, before?.signals ?? null, paperId, rows))
    if (current && signature) this.snapshot.set(paperId, { signals: current, signature })
    else this.snapshot.delete(paperId)
    this.deps.emit()
  }

  private async input(paperId: string): Promise<{ text: string; hash: string } | null> {
    const { store } = this.deps
    const read = await store.readPaper(paperId).catch(() => null)
    if (!read?.ok) return null
    const summary = await store.readSummary(paperId).catch(() => null)
    const text = embeddingInput(read.value, summary?.ok ? summary.value : null)
    return { text, hash: sha256(text) }
  }
}
