import type { CostOperation } from '../../shared/summary'
import type { ProjectStore } from '../project/ProjectStore'

/** Spending log in costs/<device-id>.jsonl; the monthly total adds up every device's file. */
export class CostLedger {
  constructor(
    private readonly store: ProjectStore,
    private readonly deviceId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** `estimated`: the call was cut off before it reported its cost; `costUsd` is the per-operation cap. */
  append(e: { paperId: string; batchId?: string; model: string; costUsd: number; operation?: CostOperation; estimated?: boolean }): Promise<void> {
    return this.store.appendCost(this.deviceId, {
      at: this.now().toISOString(),
      paper_id: e.paperId,
      batch_id: e.batchId ?? null,
      model: e.model,
      cost_usd: e.costUsd,
      operation: e.operation ?? 'summarize',
      ...(e.estimated ? { estimated: true as const } : {})
    })
  }

  /** Calendar month in UTC. */
  async monthTotal(at: Date = this.now()): Promise<number> {
    const month = at.toISOString().slice(0, 7)
    return (await this.store.readCosts()).filter((c) => c.at.startsWith(month)).reduce((sum, c) => sum + c.cost_usd, 0)
  }
}
