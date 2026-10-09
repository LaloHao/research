import type { LlmConfig } from '../../shared/summary'
import { LlmError } from './LlmProvider'

export interface BudgetLimits {
  perOperationUsd: number
  perBatchUsd: number
  perMonthUsd: number | null
}

export interface Reservation {
  /** Records the real cost; the reservation is freed. */
  settle(actualUsd: number): void
  /** Frees the reservation without spending (the call never happened). */
  release(): void
}

export function limitsFromConfig(llm: LlmConfig): BudgetLimits {
  return { perOperationUsd: llm.budget.per_operation_usd, perBatchUsd: llm.budget.per_batch_usd, perMonthUsd: llm.budget.per_month_usd }
}

const fits = (spent: number, reserved: number, estimate: number, limit: number): boolean =>
  reserved === 0 ? spent < limit : spent + reserved + estimate <= limit

/** Reservation-based admission: concurrent calls can never jointly overshoot a cap. */
export class BudgetGuard {
  private estimate: number
  private monthReserved = 0
  private readonly batchSpent = new Map<string, number>()
  private readonly batchReserved = new Map<string, number>()

  constructor(
    private readonly limits: () => BudgetLimits,
    private readonly monthSpent: () => Promise<number>,
    initialEstimate = 0.05
  ) {
    this.estimate = initialEstimate
  }

  currentEstimate(): number {
    return Math.min(this.estimate, this.limits().perOperationUsd)
  }

  async admit(batchId?: string): Promise<Reservation> {
    const monthSpent = this.limits().perMonthUsd === null ? 0 : await this.monthSpent()
    // Everything below runs synchronously, so check and reservation cannot interleave with another admit().
    const limits = this.limits()
    const estimate = this.currentEstimate()
    if (batchId !== undefined && !fits(this.batchSpent.get(batchId) ?? 0, this.batchReserved.get(batchId) ?? 0, estimate, limits.perBatchUsd)) {
      throw new LlmError('budget_exceeded')
    }
    if (limits.perMonthUsd !== null && !fits(monthSpent, this.monthReserved, estimate, limits.perMonthUsd)) throw new LlmError('budget_exceeded')
    this.monthReserved += estimate
    if (batchId !== undefined) this.batchReserved.set(batchId, (this.batchReserved.get(batchId) ?? 0) + estimate)
    let done = false
    const unreserve = (): void => {
      this.monthReserved -= estimate
      if (batchId !== undefined) this.batchReserved.set(batchId, (this.batchReserved.get(batchId) ?? 0) - estimate)
    }
    return {
      settle: (actualUsd) => {
        if (done) return
        done = true
        unreserve()
        if (batchId !== undefined) this.batchSpent.set(batchId, (this.batchSpent.get(batchId) ?? 0) + actualUsd)
        this.estimate = Math.max(this.estimate, actualUsd)
      },
      release: () => {
        if (done) return
        done = true
        unreserve()
      }
    }
  }
}
