import type { WritingPlan } from '../../shared/writing/api'
import type { CostOperation } from '../../shared/summary'
import { operationCap, type BudgetGuard, type BudgetLimits } from './BudgetGuard'
import type { CostLedger } from './CostLedger'
import { failedCallCost } from './LlmProvider'

export interface CappedDeps {
  budget: BudgetGuard
  ledger: CostLedger
  limits: () => BudgetLimits
}

/** The cost confirmation's numbers for one operation of `kind` (its learned estimate, its cap, the month). */
export async function operationPlan(deps: CappedDeps, kind: CostOperation): Promise<WritingPlan> {
  const limits = deps.limits()
  return { estimateUsd: deps.budget.currentEstimate(kind), capUsd: operationCap(limits, kind), monthSpentUsd: await deps.ledger.monthTotal(), monthCapUsd: limits.perMonthUsd }
}

/**
 * One confirmed Claude call of `kind` under its own cap: the steps FacetFiller, ScreeningSuggester and ChatService
 * take inline, packaged for «Redacción»'s operations (draft, cite_check, outline, style). Admits it (refused with
 * `budget_exceeded` over the monthly cap), hands `call` its --max-budget-usd, logs what it cost in the ledger (a call cut
 * off is charged at what `failedCallCost` says, marked estimated) and settles the reservation, which also teaches the
 * estimate. The caller confirms first (`ipcArgs.confirmed`) and validates `call`'s output itself.
 */
export async function runCappedOperation<T extends { costUsd: number; model: string }>(
  deps: CappedDeps,
  op: { kind: CostOperation; model: string; paperId?: string },
  call: (maxUsd: number) => Promise<T>
): Promise<T> {
  const reservation = await deps.budget.admit(undefined, op.kind)
  let spent = 0
  let estimated = false
  try {
    const result = await call(operationCap(deps.limits(), op.kind))
    spent = result.costUsd
    await deps.ledger.append({ paperId: op.paperId ?? '', model: result.model, costUsd: result.costUsd, operation: op.kind })
    return result
  } catch (error) {
    const charge = failedCallCost(error)
    if (charge.costUsd > 0 && spent === 0) {
      spent = charge.costUsd
      estimated = charge.estimated
      await deps.ledger.append({ paperId: op.paperId ?? '', model: op.model, costUsd: charge.costUsd, operation: op.kind, estimated: charge.estimated })
    }
    throw error
  } finally {
    reservation.settle(spent, { estimated })
  }
}
