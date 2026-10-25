import { COST_OPERATIONS, type CostOperation, type LlmConfig } from '../../shared/summary'
import { LlmError } from './LlmProvider'

export interface BudgetLimits {
  perOperationUsd: number
  perBatchUsd: number
  perMonthUsd: number | null
  /** One «Sugerir facetas» run (an agent run over the whole library); the per-operation cap when absent. */
  perFacetSuggestionUsd?: number
  /** One chat answer; the per-operation cap when absent. */
  perChatMessageUsd?: number
  /** «Redacción»'s operations (draft, cite_check, outline, style); the per-operation cap when absent. */
  perDraftUsd?: number
  perCiteCheckUsd?: number
  perOutlineUsd?: number
  perStyleUsd?: number
  /** The tutor's operations (tutor, alternatives, reverse_outline, rq_coverage); the per-operation cap when absent. */
  perTutorUsd?: number
  perAlternativesUsd?: number
  perReverseOutlineUsd?: number
  perRqCoverageUsd?: number
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
    perFacetSuggestionUsd: llm.budget.per_facet_suggestion_usd,
    perChatMessageUsd: llm.budget.per_chat_message_usd,
    perDraftUsd: llm.budget.per_draft_usd,
    perCiteCheckUsd: llm.budget.per_cite_check_usd,
    perOutlineUsd: llm.budget.per_outline_usd,
    perStyleUsd: llm.budget.per_style_usd,
    perTutorUsd: llm.budget.per_tutor_usd,
    perAlternativesUsd: llm.budget.per_alternatives_usd,
    perReverseOutlineUsd: llm.budget.per_reverse_outline_usd,
    perRqCoverageUsd: llm.budget.per_rq_coverage_usd
  }
}

/** The most one call of `operation` may spend (its --max-budget-usd), which also bounds its learned estimate. */
export function operationCap(limits: BudgetLimits, operation: CostOperation): number {
  if (operation === 'suggest_facets') return limits.perFacetSuggestionUsd ?? limits.perOperationUsd
  if (operation === 'chat') return limits.perChatMessageUsd ?? limits.perOperationUsd
  if (operation === 'draft') return limits.perDraftUsd ?? limits.perOperationUsd
  if (operation === 'cite_check') return limits.perCiteCheckUsd ?? limits.perOperationUsd
  if (operation === 'outline') return limits.perOutlineUsd ?? limits.perOperationUsd
  if (operation === 'style') return limits.perStyleUsd ?? limits.perOperationUsd
  if (operation === 'tutor') return limits.perTutorUsd ?? limits.perOperationUsd
  if (operation === 'alternatives') return limits.perAlternativesUsd ?? limits.perOperationUsd
  if (operation === 'reverse_outline') return limits.perReverseOutlineUsd ?? limits.perOperationUsd
  if (operation === 'rq_coverage') return limits.perRqCoverageUsd ?? limits.perOperationUsd
  return limits.perOperationUsd
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
