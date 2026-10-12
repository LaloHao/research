/**
 * A run's time limit that can be held: while an action waits for the user's decision the clock stops, so the limit
 * counts Claude's own time only. Holds nest; the clock runs again when the last one is released.
 */
export class RunClock {
  private holds = 0
  private left = 0
  private since = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private expire: (() => void) | null = null
  private done = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Arms the limit (the provider does, when the run starts); returns the function that disarms it for good. */
  start(ms: number, onExpire: () => void): () => void {
    this.clear()
    this.left = ms
    this.expire = onExpire
    this.done = false
    this.resume()
    return () => {
      this.done = true
      this.clear()
    }
  }

  /** Stops the clock until the returned release is called (a second call of the same release does nothing). */
  hold(): () => void {
    this.holds++
    if (this.holds === 1) this.pause()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      if (this.holds === 0) this.resume()
    }
  }

  private pause(): void {
    if (!this.timer) return
    this.left -= this.now() - this.since
    this.clear()
  }

  private resume(): void {
    if (this.done || !this.expire || this.holds > 0 || this.timer) return
    this.since = this.now()
    const expire = this.expire
    this.timer = setTimeout(() => {
      this.timer = null
      this.done = true
      expire()
    }, Math.max(0, this.left))
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
