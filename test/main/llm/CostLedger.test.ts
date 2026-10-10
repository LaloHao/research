import { describe, expect, it } from 'vitest'
import { CostLedger } from '../../../src/main/llm/CostLedger'
import { ProjectStore } from '../../../src/main/project/ProjectStore'
import { tmpDir } from '../../helpers/tmp'

describe('CostLedger', () => {
  it('records calls and sums the current month across devices', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const now = new Date('2026-10-08T12:00:00.000Z')
    const here = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => now)
    const there = new CostLedger(store, '22222222-2222-2222-2222-222222222222', () => now)
    await here.append({ paperId: 'a', model: 'sonnet', costUsd: 0.1 })
    await there.append({ paperId: 'b', batchId: 'x', model: 'sonnet', costUsd: 0.2 })
    await store.appendCost('11111111-1111-1111-1111-111111111111', {
      at: '2026-09-30T23:00:00.000Z',
      paper_id: 'c',
      batch_id: null,
      model: 'sonnet',
      cost_usd: 5,
      operation: 'summarize'
    })
    expect(await here.monthTotal()).toBeCloseTo(0.3)
    expect((await store.readCosts()).find((c) => c.paper_id === 'b')?.batch_id).toBe('x')
  })

  it('records the operation of each call', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date('2026-10-10T12:00:00.000Z'))
    await ledger.append({ paperId: 'a', model: 'sonnet', costUsd: 0.1 })
    await ledger.append({ paperId: 'b', model: 'sonnet', costUsd: 0.2, operation: 'suggest_relations' })
    expect((await store.readCosts()).map((c) => [c.paper_id, c.operation])).toEqual([
      ['a', 'summarize'],
      ['b', 'suggest_relations']
    ])
  })

  it('marks an estimated charge (a run cut off before it reported its cost) and counts it in the month', async () => {
    const store = await ProjectStore.create(await tmpDir(), 'Thesis')
    const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date('2026-10-10T12:00:00.000Z'))
    await ledger.append({ paperId: 'a', model: 'sonnet', costUsd: 0.1 })
    await ledger.append({ paperId: 'b', model: 'sonnet', costUsd: 0.5, estimated: true })
    expect((await store.readCosts()).map((c) => c.estimated)).toEqual([undefined, true])
    expect(await ledger.monthTotal()).toBeCloseTo(0.6)
  })
})
