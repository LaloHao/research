import { describe, expect, it } from 'vitest'
import { BudgetGuard, limitsFromConfig } from '../../../src/main/llm/BudgetGuard'
import { operationPlan, runCappedOperation } from '../../../src/main/llm/cappedOperation'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { DEFAULT_LLM_CONFIG } from '../../../src/shared/summary'
import { tmpDir } from '../../helpers/tmp'

async function setup(perMonthUsd: number | null = null) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date('2026-10-22T12:00:00.000Z'))
  const limits = () => ({ ...limitsFromConfig(DEFAULT_LLM_CONFIG), perMonthUsd })
  const budget = new BudgetGuard(limits, () => ledger.monthTotal(), 0.05, { draft: 0.2 })
  return { store, deps: { budget, ledger, limits } }
}

describe('runCappedOperation', () => {
  it('passes the kind’s own cap, logs the cost under its kind and learns the estimate', async () => {
    const { store, deps } = await setup()
    let cap = 0
    const result = await runCappedOperation(deps, { kind: 'draft', model: 'sonnet' }, async (maxUsd) => {
      cap = maxUsd
      return { costUsd: 0.4, model: 'claude-sonnet', text: 'ok' }
    })
    expect(cap).toBe(1)
    expect(result.text).toBe('ok')
    expect((await store.readCosts()).map((c) => [c.operation, c.cost_usd, c.model, c.paper_id])).toEqual([['draft', 0.4, 'claude-sonnet', '']])
    expect(deps.budget.currentEstimate('draft')).toBe(0.4)
    expect(await operationPlan(deps, 'draft')).toEqual({ estimateUsd: 0.4, capUsd: 1, monthSpentUsd: 0.4, monthCapUsd: null })
  })

  it('charges a call cut off at its estimated cost, and rethrows', async () => {
    const { store, deps } = await setup()
    await expect(
      runCappedOperation(deps, { kind: 'style', model: 'haiku' }, async () => {
        throw new LlmError('llm_timeout', 0.5, { estimated: true })
      })
    ).rejects.toMatchObject({ code: 'llm_timeout' })
    expect((await store.readCosts()).map((c) => [c.operation, c.cost_usd, c.estimated])).toEqual([['style', 0.5, true]])
    // An estimated charge never moves the estimate.
    expect(deps.budget.currentEstimate('style')).toBe(0.05)
  })

  it('refuses before calling when the month is spent', async () => {
    const { store, deps } = await setup(1)
    await store.appendCost('11111111-1111-1111-1111-111111111111', { at: '2026-10-01T00:00:00.000Z', paper_id: '', batch_id: null, model: 'sonnet', cost_usd: 1, operation: 'chat' })
    let called = false
    await expect(
      runCappedOperation(deps, { kind: 'outline', model: 'sonnet' }, async () => {
        called = true
        return { costUsd: 0, model: 'sonnet' }
      })
    ).rejects.toMatchObject({ code: 'budget_exceeded' })
    expect(called).toBe(false)
  })
})
