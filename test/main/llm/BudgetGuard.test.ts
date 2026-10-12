import { describe, expect, it } from 'vitest'
import { BudgetGuard, limitsFromConfig, operationCap, type BudgetLimits } from '../../../src/main/llm/BudgetGuard'
import { DEFAULT_LLM_CONFIG } from '../../../src/shared/summary'

const limits = (over: Partial<BudgetLimits> = {}) => (): BudgetLimits => ({
  perOperationUsd: 0.5,
  perBatchUsd: 1,
  perMonthUsd: null,
  ...over
})

describe('BudgetGuard', () => {
  it('keeps a separate estimate per operation', async () => {
    const g = new BudgetGuard(limits(), async () => 0, 0.05, { suggest_relations: 0.25 })
    expect(g.currentEstimate()).toBe(0.05)
    expect(g.currentEstimate('suggest_relations')).toBe(0.25)
    ;(await g.admit(undefined, 'suggest_relations')).settle(0.4)
    expect(g.currentEstimate('suggest_relations')).toBe(0.4)
    expect(g.currentEstimate('summarize')).toBe(0.05)
  })

  it('counts an estimated charge in the batch without learning it as the estimate', async () => {
    const g = new BudgetGuard(limits({ perBatchUsd: 0.5 }), async () => 0, 0.05, { suggest_relations: 0.25 })
    ;(await g.admit('b', 'suggest_relations')).settle(0.5, { estimated: true })
    expect(g.currentEstimate('suggest_relations')).toBe(0.25)
    await expect(g.admit('b', 'suggest_relations')).rejects.toMatchObject({ code: 'budget_exceeded' })
  })

  it('admits the first call of a batch even on a tiny budget, then stops at the cap', async () => {
    const g = new BudgetGuard(limits({ perBatchUsd: 0.1 }), async () => 0)
    const r1 = await g.admit('b')
    r1.settle(0.08)
    const r2 = await g.admit('b')
    r2.settle(0.04)
    await expect(g.admit('b')).rejects.toMatchObject({ code: 'budget_exceeded' })
    await expect(g.admit('other')).resolves.toBeDefined()
  })

  it('counts in-flight reservations so concurrent calls cannot overshoot', async () => {
    const g = new BudgetGuard(limits({ perBatchUsd: 0.12 }), async () => 0, 0.05)
    await g.admit('b')
    await g.admit('b')
    await expect(g.admit('b')).rejects.toMatchObject({ code: 'budget_exceeded' })
  })

  it('release() frees a reservation without counting it as spent', async () => {
    const g = new BudgetGuard(limits({ perBatchUsd: 0.06 }), async () => 0, 0.05)
    const r = await g.admit('b')
    r.release()
    r.settle(1)
    await expect(g.admit('b')).resolves.toBeDefined()
  })

  it('enforces the monthly cap from the ledger', async () => {
    const g = new BudgetGuard(limits({ perMonthUsd: 2 }), async () => 2)
    await expect(g.admit()).rejects.toMatchObject({ code: 'budget_exceeded' })
    const ok = new BudgetGuard(limits({ perMonthUsd: 2 }), async () => 1)
    await expect(ok.admit()).resolves.toBeDefined()
  })

  it('learns the estimate from real costs, capped by the per-operation limit', async () => {
    const g = new BudgetGuard(limits({ perOperationUsd: 0.2 }), async () => 0)
    expect(g.currentEstimate()).toBe(0.05)
    ;(await g.admit()).settle(0.12)
    expect(g.currentEstimate()).toBe(0.12)
    ;(await g.admit()).settle(0.9)
    expect(g.currentEstimate()).toBe(0.2)
  })

  it('reads limits from the project config', () => {
    expect(limitsFromConfig(DEFAULT_LLM_CONFIG)).toEqual({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null, perFacetSuggestionUsd: 2, perChatMessageUsd: 0.5 })
  })

  it('caps a chat answer with its own cap, and refuses it over the monthly cap', async () => {
    expect(operationCap({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null, perChatMessageUsd: 0.3 }, 'chat')).toBe(0.3)
    expect(operationCap({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null }, 'chat')).toBe(0.5)
    const g = new BudgetGuard(limits({ perChatMessageUsd: 0.3 }), async () => 0, 0.05, { chat: 0.1 })
    expect(g.currentEstimate('chat')).toBe(0.1)
    ;(await g.admit(undefined, 'chat')).settle(0.8)
    expect(g.currentEstimate('chat')).toBe(0.3)
    const capped = new BudgetGuard(limits({ perMonthUsd: 1 }), async () => 1, 0.05, { chat: 0.1 })
    await expect(capped.admit(undefined, 'chat')).rejects.toMatchObject({ code: 'budget_exceeded' })
  })

  it('caps a facet suggestion run with its own cap, every other operation with the per-operation one', async () => {
    expect(operationCap({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null, perFacetSuggestionUsd: 2 }, 'suggest_facets')).toBe(2)
    expect(operationCap({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null }, 'suggest_facets')).toBe(0.5)
    expect(operationCap({ perOperationUsd: 0.5, perBatchUsd: 10, perMonthUsd: null, perFacetSuggestionUsd: 2 }, 'fill_facets')).toBe(0.5)
    const g = new BudgetGuard(limits({ perFacetSuggestionUsd: 2, perBatchUsd: 10 }), async () => 0, 0.05, { suggest_facets: 0.5 })
    expect(g.currentEstimate('suggest_facets')).toBe(0.5)
    ;(await g.admit(undefined, 'suggest_facets')).settle(1.5)
    expect(g.currentEstimate('suggest_facets')).toBe(1.5)
    ;(await g.admit(undefined, 'suggest_facets')).settle(3)
    expect(g.currentEstimate('suggest_facets')).toBe(2)
    expect(g.currentEstimate('fill_facets')).toBe(0.05)
  })
})
