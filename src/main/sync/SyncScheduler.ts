export interface SchedulerDeps {
  run: () => Promise<unknown>
  /** Checked at every tick: false skips it (a decision waiting, a trash operation moving folders). */
  canRun: () => boolean
  /** Read at every tick, so a settings change applies without reopening the project. */
  enabled: () => boolean
  intervalMs: () => number
}

/** The automatic sync: once when the project opens, then every interval; never two at once, never a dialog. */
export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: Promise<void> | null = null
  private stopped = false

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.tick()
  }

  /** The settings changed: the next sync is a full (new) interval from now, or none when turned off. */
  reschedule(): void {
    if (this.stopped || this.current) return
    this.clear()
    this.arm()
  }

  /** No more syncs; resolves once a sync in progress has finished. */
  async stop(): Promise<void> {
    this.stopped = true
    this.clear()
    await this.current
  }

  private tick(): void {
    this.timer = null
    if (this.stopped) return
    if (!this.deps.enabled() || !this.deps.canRun()) return this.arm()
    this.current = this.deps
      .run()
      .then(
        () => undefined,
        (error: unknown) => console.error('automatic sync', error)
      )
      .finally(() => {
        this.current = null
        this.arm()
      })
  }

  private arm(): void {
    if (this.stopped || this.timer || !this.deps.enabled()) return
    this.timer = setTimeout(() => this.tick(), this.deps.intervalMs())
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
