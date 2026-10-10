import type { JobRecord, JobSpec, JobType } from '../../shared/jobs'
import type { IndexCache, JobRow } from '../cache/IndexCache'

export type JobHandler = (spec: JobSpec, signal: AbortSignal, report: (progress: number) => void) => Promise<{ paperId?: string; message?: string }>

export interface QueueLimits {
  total: number
  byType?: Partial<Record<JobType, number>>
}

/** Background work persisted in the cache, so a quit or crash resumes where it stopped. */
export class JobQueue {
  private readonly running = new Map<number, { controller: AbortController; type: JobType }>()
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

  private pump(): void {
    if (!this.started) return
    while (this.running.size < this.limits.total) {
      const job = this.cache.nextQueuedJob(this.fullTypes())
      if (!job) break
      const type = (JSON.parse(job.spec) as JobSpec).type
      const controller = new AbortController()
      this.running.set(job.id, { controller, type })
      this.cache.updateJob(job.id, { state: 'running' }, this.now())
      this.emit()
      void this.run(job, controller)
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
