/**
 * Requests where only the newest answer counts: each `start` makes the earlier ones stale, and so does `drop` (an edit
 * or «Cancelar»). An answer is applied only while the check its `start` returned still says it is current.
 */
export class LatestRequest {
  private run = 0

  start(): () => boolean {
    const run = ++this.run
    return () => run === this.run
  }

  drop(): void {
    this.run++
  }
}
