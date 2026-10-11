interface Waiter {
  exclusive: boolean
  start: () => void
}

/**
 * Writes run side by side; an exclusive holder (the git sync's commit, merge and checkout) waits for the writes in
 * flight, then runs alone while new writes wait behind it, in arrival order. Never take it again inside itself.
 */
export class WriteGate {
  private writers = 0
  private held = false
  private readonly waiting: Waiter[] = []

  shared<T>(fn: () => Promise<T>): Promise<T> {
    return this.run(false, fn)
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.run(true, fn)
  }

  private async run<T>(exclusive: boolean, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((start) => {
      this.waiting.push({ exclusive, start })
      this.admit()
    })
    try {
      return await fn()
    } finally {
      if (exclusive) this.held = false
      else this.writers--
      this.admit()
    }
  }

  private admit(): void {
    while (this.waiting.length > 0 && !this.held) {
      const next = this.waiting[0]
      if (next.exclusive) {
        if (this.writers > 0) return
        this.held = true
      } else {
        this.writers++
      }
      this.waiting.shift()
      next.start()
    }
  }
}
