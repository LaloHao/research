import { COST_OPERATIONS, type CostOperation, type LlmConfig } from '../../shared/summary'
import { LlmError } from './LlmProvider'

export interface BudgetLimits {
  perOperationUsd: number
  perBatchUsd: number
  perMonthUsd: number | null
  /** One «Sugerir facetas» run (an agent run over the whole library); the per-operation cap when absent. */
  perFacetSuggestionUsd?: number
}

export interface Reservation {
  /** Records the cost; the reservation is freed. An `estimated` cost (a run cut off) counts but does not move the estimate. */
  settle(actualUsd: number, opts?: { estimated?: boolean }): void
  /** Frees the reservation without spending (the call never happened). */
  release(): void
}

export function limitsFromConfig(llm: LlmConfig): BudgetLimits {
  return {
    perOperationUsd: llm.budget.per_operation_usd,
    perBatchUsd: llm.budget.per_batch_usd,
    perMonthUsd: llm.budget.per_month_usd,
    perFacetSuggestionUsd: llm.budget.per_facet_suggestion_usd
  }
}

/** The most one call of `operation` may spend (its --max-budget-usd), which also bounds its learned estimate. */
export function operationCap(limits: BudgetLimits, operation: CostOperation): number {
  return operation === 'suggest_facets' ? (limits.perFacetSuggestionUsd ?? limits.perOperationUsd) : limits.perOperationUsd
}

const fits = (spent: number, reserved: number, estimate: number, limit: number): boolean =>
  reserved === 0 ? spent < limit : spent + reserved + estimate <= limit

/** Reservation-based admission: concurrent calls can never jointly overshoot a cap. */
export class BudgetGuard {
  private readonly estimates: Map<CostOperation, number>
  private monthReserved = 0
  private readonly batchSpent = new Map<string, number>()
  private readonly batchReserved = new Map<string, number>()

  constructor(
    private readonly limits: () => BudgetLimits,
    private readonly monthSpent: () => Promise<number>,
    initialEstimate = 0.05,
    initialEstimates: Partial<Record<CostOperation, number>> = {}
  ) {
    this.estimates = new Map(COST_OPERATIONS.map((op) => [op, initialEstimates[op] ?? initialEstimate]))
  }

  /** The largest real cost seen for `operation` (never above that operation's cap). */
  currentEstimate(operation: CostOperation = 'summarize'): number {
    return Math.min(this.estimates.get(operation) ?? 0, operationCap(this.limits(), operation))
  }

  async admit(batchId?: string, operation: CostOperation = 'summarize'): Promise<Reservation> {
    const monthSpent = this.limits().perMonthUsd === null ? 0 : await this.monthSpent()
    // Everything below runs synchronously, so check and reservation cannot interleave with another admit().
    const limits = this.limits()
    const estimate = this.currentEstimate(operation)
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
      settle: (actualUsd, opts) => {
        if (done) return
        done = true
        unreserve()
        if (batchId !== undefined) this.batchSpent.set(batchId, (this.batchSpent.get(batchId) ?? 0) + actualUsd)
        if (!opts?.estimated) this.estimates.set(operation, Math.max(this.estimates.get(operation) ?? 0, actualUsd))
      },
      release: () => {
        if (done) return
        done = true
        unreserve()
      }
    }
  }
}
