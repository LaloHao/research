import { join } from 'node:path'
import { IndexCache } from '../../src/main/cache/IndexCache'
import { BudgetGuard, limitsFromConfig } from '../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../src/main/llm/CostLedger'
import { MapService } from '../../src/main/map/MapService'
import { startLibraryMcpServer } from '../../src/main/mcp/LibraryMcpServer'
import { libraryTools } from '../../src/main/mcp/libraryTools'
import { scopeLibraryTools } from '../../src/main/mcp/scopedTools'
import { ProjectStore } from '../../src/main/project/ProjectStore'
import { DraftService } from '../../src/main/writing/DraftService'
import type { DraftFile, DraftInput, DraftMeta, DraftStreamUpdate, DraftVersion } from '../../src/shared/writing/draft'
import { DEVICE } from './chats'
import { chatAnswer, FakeLlmProvider, type ChatResponse } from './llm'
import { DRAIN_ID, LOGHUB_ID, seedPair } from './pair'
import { tmpDir } from './tmp'

export const DRAFT_AT = '2026-10-22T12:00:00.000Z'
export const DRAFT_ID_A = '20261022-120000-a1b2'
export const DRAIN_QUOTE = 'Drain parses log messages online'
export const LOGHUB_QUOTE = 'Loghub is a large collection of system log datasets'
export const DRAIN_DRAFT = `Online parsers exist [[${DRAIN_ID}|p. 1|"${DRAIN_QUOTE}"]].`

export function draftVersion(over: Partial<DraftVersion> = {}): DraftVersion {
  return { at: '2026-10-22T12:00:05.000Z', model: 'claude-sonnet-5', cost_usd: 0.1, stopped: false, ...over }
}

export function draftMeta(over: Partial<DraftMeta> = {}): DraftMeta {
  return {
    schema_version: 1,
    id: DRAFT_ID_A,
    title: 'Log parsing',
    purpose: 'Compare online parsers.',
    rq: null,
    papers: [DRAIN_ID],
    length: 'short',
    model: 'sonnet',
    created_at: DRAFT_AT,
    updated_at: DRAFT_AT,
    archived: false,
    cost_usd: 0,
    versions: [],
    updated_on: 'laptop',
    ...over
  }
}

/** A draft whose `cost_usd` adds up its versions, as the app writes it. */
export function draftFile(texts: string[] = [DRAIN_DRAFT], over: Partial<DraftMeta> = {}, versions?: DraftVersion[]): DraftFile {
  const vs = versions ?? texts.map((_t, i) => draftVersion({ at: `2026-10-22T12:0${i}:05.000Z` }))
  const cost = Math.round(vs.reduce((sum, v) => sum + v.cost_usd, 0) * 10000) / 10000
  return { meta: draftMeta({ versions: vs, cost_usd: cost, ...over }), texts }
}

export function draftInputOf(over: Partial<DraftInput> = {}): DraftInput {
  return { title: 'Log parsing', purpose: 'Compare online parsers.', rq: null, papers: [DRAIN_ID], length: 'short', model: 'sonnet', ...over }
}

export { DRAIN_ID, LOGHUB_ID }

/** Drain and Loghub in the library, a draft service with a fixed clock, and the fake provider answering DRAIN_DRAFT. */
export async function setupDrafts(opts: { responses?: ChatResponse[] } = {}) {
  const store = await ProjectStore.create(await tmpDir(), 'Thesis')
  const cache = IndexCache.open(join(store.cacheDir, 'index.sqlite'))
  await seedPair(store, cache)
  const provider = new FakeLlmProvider([], [], opts.responses ?? [chatAnswer(DRAIN_DRAFT, 0.12)])
  const ledger = new CostLedger(store, DEVICE, () => new Date(DRAFT_AT))
  const budget = new BudgetGuard(() => limitsFromConfig(store.config.llm), () => ledger.monthTotal(), 0.05, { draft: 0.2 })
  const updates: DraftStreamUpdate[] = []
  const counter = { events: 0 }
  const hex = ['a1b2', 'c3d4', 'e5f6', '0a0b']
  let n = 0
  const drafts = new DraftService({
    store,
    cache,
    provider,
    budget,
    ledger,
    machine: 'laptop',
    startTools: (o, papers) => startLibraryMcpServer(scopeLibraryTools(libraryTools({ store, cache, map: new MapService({ store, cache }), embeddings: null }), papers), o),
    emit: () => counter.events++,
    stream: (u) => updates.push(u),
    now: () => new Date(DRAFT_AT),
    randomHex: () => hex[n++ % hex.length]
  })
  return { store, cache, provider, ledger, budget, drafts, updates, counter }
}
