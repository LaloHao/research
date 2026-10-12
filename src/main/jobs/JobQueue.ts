import type { JobRecord, JobSpec, JobType } from '../../shared/jobs'
import type { IndexCache, JobRow } from '../cache/IndexCache'

export type JobHandler = (spec: JobSpec, signal: AbortSignal, report: (progress: number) => void) => Promise<{ paperId?: string; message?: string }>

export interface QueueLimits {
  total: number
  byType?: Partial<Record<JobType, number>>
}

interface Running {
  controller: AbortController
  type: JobType
  /** The paper the job works on, when its spec names one. */
  paperId: string | null
  /** Settles once the job has stopped and its state is recorded. */
  done: Promise<void>
}

/** Background work persisted in the cache, so a quit or crash resumes where it stopped. */
export class JobQueue {
  private readonly running = new Map<number, Running>()
  private readonly progress = new Map<number, number>()
  private readonly listeners = new Set<() => void>()
  private idleWaiters: (() => void)[] = []
  private started = false
  private stopping = false
  private readonly limits: QueueLimits

  constructor(
    private readonly cache: IndexCache,
    private readonly handler: JobHandler,
    limits: number | QueueLimits = 2,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.limits = typeof limits === 'number' ? { total: limits } : limits
  }

  start(): void {
    this.cache.requeueRunningJobs(this.now())
    this.started = true
    this.pump()
  }

  /** Aborts running jobs and leaves them queued so the next session resumes them. */
  async stop(): Promise<void> {
    this.started = false
    this.stopping = true
    for (const { controller } of this.running.values()) controller.abort()
    while (this.running.size > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    this.stopping = false
  }

  enqueue(spec: JobSpec): number {
    const id = this.cache.insertJob(JSON.stringify(spec), this.now())
    this.emit()
    this.pump()
    return id
  }

  cancel(id: number): void {
    const entry = this.running.get(id)
    if (entry) {
      entry.controller.abort()
      return
    }
    if (this.cache.getJob(id)?.state === 'queued') {
      this.cache.updateJob(id, { state: 'cancelled' }, this.now())
      this.emit()
      this.pump()
    }
  }

  list(limit = 50): JobRecord[] {
    return this.cache.listJobs(limit).map((row) => toRecord(row, this.progress.get(row.id) ?? null))
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  whenIdle(): Promise<void> {
    if (this.running.size === 0 && !this.cache.nextQueuedJob()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * The job's record once it finished (done, failed or cancelled); null when it is still queued or running after
   * `timeoutMs` (or the id is unknown), so a caller can say it goes on in Actividad.
   */
  whenDone(id: number, timeoutMs: number): Promise<JobRecord | null> {
    const finished = (): JobRecord | null => {
      const row = this.cache.getJob(id)
      return row && (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled') ? toRecord(row, null) : null
    }
    const now = finished()
    if (now || timeoutMs <= 0) return Promise.resolve(now)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(finished())
      }, timeoutMs)
      const off = this.onChange(() => {
        const record = finished()
        if (!record) return
        clearTimeout(timer)
        off()
        resolve(record)
      })
    })
  }

  private pump(): void {
    if (!this.started) return
    while (this.running.size < this.limits.total) {
      const job = this.cache.nextQueuedJob(this.fullTypes())
      if (!job) break
      const spec = JSON.parse(job.spec) as JobSpec
      const paperId = 'paperId' in spec ? spec.paperId : null
      // A paper in the trash is never worked on (e.g. a job requeued after a restart, or queued by a late trigger).
      if (paperId !== null && this.cache.isTrashed(paperId)) {
        this.cache.updateJob(job.id, { state: 'cancelled' }, this.now())
        this.emit()
        continue
      }
      const controller = new AbortController()
      const entry: Running = { controller, type: spec.type, paperId, done: Promise.resolve() }
      this.running.set(job.id, entry)
      this.cache.updateJob(job.id, { state: 'running' }, this.now())
      this.emit()
      entry.done = this.run(job, controller)
    }
    if (this.running.size === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /** Job types that already use all their slots. */
  private fullTypes(): string[] {
    const counts = new Map<JobType, number>()
    for (const { type } of this.running.values()) counts.set(type, (counts.get(type) ?? 0) + 1)
    return Object.entries(this.limits.byType ?? {})
      .filter(([type, cap]) => (counts.get(type as JobType) ?? 0) >= (cap ?? Infinity))
      .map(([type]) => type)
  }

  cancelBatch(batchId: string): number {
    const n = this.cache.cancelQueuedBatch(batchId, this.now())
    if (n) this.emit()
    return n
  }

  /** Cancels every queued job of these types (e.g. OpenAlex's daily limit stops all pending citation work). */
  cancelTypes(types: JobType[]): number {
    const n = this.cache.cancelQueuedTypes(types, this.now())
    if (n) this.emit()
    return n
  }

  /** Cancels the queued jobs of these papers (running ones go on). */
  cancelQueuedPapers(ids: string[]): number {
    const n = this.cache.cancelQueuedPapers(ids, this.now())
    if (n) this.emit()
    return n
  }

  /**
   * Cancels every queued job of these papers and aborts their running ones, resolving once none of them still runs:
   * a paper moved to the trash must not be written to by a job that finishes afterwards.
   */
  async cancelPapers(ids: string[]): Promise<number> {
    const wanted = new Set(ids)
    let count = this.cache.cancelQueuedPapers(ids, this.now())
    const stopping: Promise<void>[] = []
    for (const entry of this.running.values()) {
      if (entry.paperId === null || !wanted.has(entry.paperId)) continue
      entry.controller.abort()
      stopping.push(entry.done)
      count++
    }
    if (count) this.emit()
    await Promise.all(stopping)
    return count
  }

  private async run(job: JobRow, controller: AbortController): Promise<void> {
    const interrupted = (): 'queued' | 'cancelled' => (this.stopping ? 'queued' : 'cancelled')
    const report = (value: number): void => {
      const next = Math.max(0, Math.min(1, value))
      const previous = this.progress.get(job.id)
      // Only a change of the whole percentage is worth a 'jobs-changed' round trip to the UI.
      if (previous !== undefined && Math.floor(previous * 100) === Math.floor(next * 100)) return
      this.progress.set(job.id, next)
      this.emit()
    }
    try {
      const result = await this.handler(JSON.parse(job.spec) as JobSpec, controller.signal, report)
      this.cache.updateJob(
        job.id,
        { state: controller.signal.aborted ? interrupted() : 'done', message: result.message ?? null, paper_id: result.paperId ?? null },
        this.now()
      )
    } catch (error) {
      this.cache.updateJob(
        job.id,
        { state: controller.signal.aborted ? interrupted() : 'failed', message: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error) },
        this.now()
      )
    } finally {
      this.progress.delete(job.id)
      this.running.delete(job.id)
      this.emit()
      this.pump()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function toRecord(row: JobRow, progress: number | null): JobRecord {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as JobSpec,
    state: row.state,
    message: row.message,
    progress,
    paperId: row.paper_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
