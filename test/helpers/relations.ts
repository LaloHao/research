import { join } from 'node:path'
import { IndexCache } from '../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../src/main/llm/CostLedger'
import type { CompleteResult } from '../../src/main/llm/LlmProvider'
import { MapService } from '../../src/main/map/MapService'
import { startLibraryMcpServer } from '../../src/main/mcp/LibraryMcpServer'
import { libraryTools } from '../../src/main/mcp/libraryTools'
import { ProjectStore } from '../../src/main/project/ProjectStore'
import { RelationService } from '../../src/main/relations/RelationService'
import { RelationSuggester } from '../../src/main/relations/RelationSuggester'
import type { JobSpec } from '../../src/shared/jobs'
import { relationId, type TypedRelation } from '../../src/shared/typedRelations'
import { FakeLlmProvider, type AgentResponse } from './llm'
import { DRAIN_ID, DRAIN_PAGES, LOGHUB_ID, LOGHUB_PAGES, seedPair } from './pair'
import { tmpDir } from './tmp'

export const NOW = '2026-10-10T12:00:00.000Z'

/** Loghub extends Drain, suggested; `id` follows from/to/type unless given. */
export function typedRelation(over: Partial<TypedRelation> = {}): TypedRelation {
  const type = over.type ?? 'extends'
  const from = over.from ?? LOGHUB_ID
  const to = over.to ?? DRAIN_ID
  return {
    type,
    from,
    to,
    status: 'suggested',
    edited: false,
    justification: 'Loghub builds on the Drain parser.',
    evidence: [{ paper: from, page: 2, quote: 'q', found: true }],
    origin: { model: 'claude-sonnet-5', at: '2026-10-10T00:00:00.000Z', prompt_version: 1, paper: from },
    updated_at: '2026-10-10T00:00:00.000Z',
    ...over,
    id: over.id ?? relationId(from, to, type)
  }
}

/** One relation as the agent answers it, quoting the pages of pair.ts verbatim. */
export const LOGHUB_EXTENDS_DRAIN = {
  from: LOGHUB_ID,
  to: DRAIN_ID,
  type: 'extends',
  justification: 'Loghub extends the Drain parser.',
  evidence: [
    { paper: LOGHUB_ID, page: 2, quote: LOGHUB_PAGES[1] },
    { paper: DRAIN_ID, page: 1, quote: DRAIN_PAGES[0] }
  ]
}

export function agentResult(relations: unknown[] = [LOGHUB_EXTENDS_DRAIN], costUsd = 0.12): CompleteResult {
  return { value: { relations }, costUsd, model: 'claude-sonnet-5' }
}

/** A project with Drain and Loghub seeded, a fake agent and a RelationService that records what it enqueues. */
export async function setupRelations(opts: { agent?: AgentResponse[] } = {}) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const provider = new FakeLlmProvider([], opts.agent ?? [agentResult()])
  const ledger = new CostLedger(store, '11111111-1111-1111-1111-111111111111', () => new Date(NOW))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal(), 0.05, { suggest_relations: 0.25 })
  const map = new MapService({ store, cache })
  const suggester = new RelationSuggester({
    store,
    cache,
    provider,
    budget,
    ledger,
    startTools: (o) => startLibraryMcpServer(libraryTools({ store, cache, map, embeddings: null }), o),
    now: () => new Date(NOW)
  })
  const enqueued: JobSpec[] = []
  const cancelled: string[] = []
  let emits = 0
  const service = new RelationService({
    store,
    cache,
    suggester,
    budget,
    emit: () => void emits++,
    enqueue: (spec) => enqueued.push(spec),
    cancelBatch: (batchId) => {
      cancelled.push(batchId)
      return 0
    },
    now: () => new Date(NOW)
  })
  await service.reindex()
  return { store, cache, provider, ledger, budget, suggester, service, enqueued, cancelled, emits: () => emits }
}
