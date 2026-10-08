import type { JobRecord, JobSpec } from '../../shared/jobs'
import type { IndexCache, JobRow } from '../cache/IndexCache'

export type JobHandler = (spec: JobSpec, signal: AbortSignal) => Promise<{ paperId?: string; message?: string }>

/** Background work persisted in the cache, so a quit or crash resumes where it stopped. */
export class JobQueue {
  private readonly running = new Map<number, AbortController>()
  private readonly listeners = new Set<() => void>()
  private idleWaiters: (() => void)[] = []
  private started = false
  private stopping = false

  constructor(
    private readonly cache: IndexCache,
    private readonly handler: JobHandler,
    private readonly concurrency = 2,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  start(): void {
    this.cache.requeueRunningJobs(this.now())
    this.started = true
    this.pump()
  }

  /** Aborts running jobs and leaves them queued so the next session resumes them. */
  async stop(): Promise<void> {
    this.started = false
    this.stopping = true
    for (const controller of this.running.values()) controller.abort()
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
    const controller = this.running.get(id)
    if (controller) {
      controller.abort()
      return
    }
    if (this.cache.getJob(id)?.state === 'queued') {
      this.cache.updateJob(id, { state: 'cancelled' }, this.now())
      this.emit()
      this.pump()
    }
  }

  list(limit = 50): JobRecord[] {
    return this.cache.listJobs(limit).map(toRecord)
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
    while (this.running.size < this.concurrency) {
      const job = this.cache.nextQueuedJob()
      if (!job) break
      const controller = new AbortController()
      this.running.set(job.id, controller)
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

  private async run(job: JobRow, controller: AbortController): Promise<void> {
    const interrupted = (): 'queued' | 'cancelled' => (this.stopping ? 'queued' : 'cancelled')
    try {
      const result = await this.handler(JSON.parse(job.spec) as JobSpec, controller.signal)
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
      this.running.delete(job.id)
      this.emit()
      this.pump()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as JobSpec,
    state: row.state,
    message: row.message,
    paperId: row.paper_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
