import { fileURLToPath } from 'node:url'
import { HttpClient } from '../../src/main/ingest/http'
import { BudgetGuard, limitsFromConfig } from '../../src/main/llm/BudgetGuard'
import { CostLedger } from '../../src/main/llm/CostLedger'
import { MappingService, type MappingServiceDeps } from '../../src/main/mapping/MappingService'
import { OpenAlexSearch } from '../../src/main/mapping/OpenAlexSearch'
import { ScreeningSuggester } from '../../src/main/mapping/ScreeningSuggester'
import type { JobSpec } from '../../src/shared/jobs'
import type { ResolvedMetadata } from '../../src/main/ingest/types'
import type { Decision, MappingRecord, ProtocolBody, ProtocolFile, ScreeningSuggestion, Search, WorkCandidate } from '../../src/shared/mapping'
import type { Route } from './fakeFetch'
import { setupLibrary } from './library'
import { FakeLlmProvider } from './llm'

export const MAPPING_A = '20261012-090000-a1b2'
export const MAPPING_B = '20261012-091500-c3d4'
export const AT = '2026-10-12T09:00:00.000Z'

/** An id of the right shape: its prefix and `n` as 12 hex digits. */
export const hexId = (prefix: 's' | 'r' | 'd' | 'g', n: number): string => `${prefix}${n.toString(16).padStart(12, '0')}`

export function protocolBody(over: Partial<ProtocolBody> = {}): ProtocolBody {
  return {
    title: 'Log anonymization with language models',
    objective: 'Map the approaches to anonymizing operational logs.',
    research_questions: [{ id: 'RQ1', text: 'Which techniques anonymize logs?' }],
    inclusion: [{ id: 'I1', text: 'Proposes or evaluates a technique that processes software logs.' }],
    exclusion: [
      { id: 'E1', text: 'Not about software logs.' },
      { id: 'E2', text: 'Not peer reviewed.' }
    ],
    years: { from: 2015, to: null },
    publication_types: ['article', 'conference'],
    ...over
  }
}

export function protocolFile(over: Partial<ProtocolFile> = {}, body: Partial<ProtocolBody> = {}): ProtocolFile {
  return {
    schema_version: 1,
    protocol: protocolBody(body),
    phases: ['title_abstract', 'full_text'],
    version: 1,
    last_ids: { rq: 1, inclusion: 1, exclusion: 2 },
    created_at: AT,
    updated_at: AT,
    history: [],
    ...over
  }
}

export function search(over: Partial<Search> = {}): Search {
  return {
    id: hexId('s', 1),
    kind: 'import',
    at: AT,
    machine: 'machine-a',
    database: 'Scopus',
    query: 'TITLE-ABS-KEY(log AND anonymization)',
    filters: {},
    request: null,
    file: 'scopus.csv',
    format: 'csv_scopus',
    count: 1,
    total: null,
    capped: false,
    skipped: 0,
    origin: null,
    discarded: null,
    ...over
  }
}

export function record(over: Partial<MappingRecord> = {}): MappingRecord {
  return {
    id: hexId('r', 1),
    title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
    authors: [{ family: 'He', given: 'Pinjia' }],
    year: 2017,
    venue: 'ICWS',
    abstract: 'We propose an online log parser that walks a tree of fixed depth.',
    kind: 'conference',
    identifiers: { doi: '10.1109/icws.2017.13' },
    sources: [hexId('s', 1)],
    paper_id: null,
    duplicate_of: null,
    merged_into: null,
    distinct_from: [],
    added_at: AT,
    updated_at: AT,
    ...over
  }
}

export function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: hexId('d', 1),
    record: hexId('r', 1),
    phase: 'title_abstract',
    reviewer: 'main',
    decision: 'include',
    criterion: null,
    note: null,
    by: 'user',
    suggestion: null,
    protocol_version: 1,
    at: '2026-10-12T10:00:00.000Z',
    machine: 'machine-a',
    replaces: [],
    undoes: null,
    ...over
  }
}

export function suggestion(over: Partial<ScreeningSuggestion> = {}): ScreeningSuggestion {
  return {
    id: hexId('g', 1),
    record: hexId('r', 1),
    phase: 'title_abstract',
    decision: 'include',
    criterion: 'I1',
    justification: 'It proposes a log parser.',
    quote: 'online log parser',
    page: null,
    found: true,
    model: 'claude-sonnet-5',
    at: '2026-10-12T09:30:00.000Z',
    protocol_version: 1,
    prompt_version: 1,
    ...over
  }
}

export function candidate(over: Partial<WorkCandidate> = {}): WorkCandidate {
  return {
    title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
    authors: [{ family: 'He', given: 'Pinjia' }],
    year: 2017,
    venue: 'ICWS',
    abstract: null,
    kind: 'conference',
    identifiers: { doi: '10.1109/ICWS.2017.13' },
    ...over
  }
}

/** Absolute path of an export under test/fixtures/mapping/. */
export const fixturePath = (name: string): string => fileURLToPath(new URL(`../fixtures/mapping/${name}`, import.meta.url))

/** A mapping service over a fresh project and library, with a fixed clock, counting ids, fake jobs and a fake Claude. */
export async function setupMappings(
  opts: { routes?: Route[]; resolver?: Record<string, ResolvedMetadata>; llm?: FakeLlmProvider; citations?: MappingServiceDeps['citations'] } = {}
) {
  const lib = await setupLibrary({ routes: opts.routes, resolver: opts.resolver })
  let changes = 0
  let n = 0
  const queued: JobSpec[] = []
  const provider = opts.llm ?? new FakeLlmProvider([])
  const ledger = new CostLedger(lib.store, '11111111-1111-1111-1111-111111111111', () => new Date('2026-10-12T10:00:00.000Z'))
  const budget = new BudgetGuard(() => limitsFromConfig(lib.store.config.llm), () => ledger.monthTotal(), 0.05, { screening: 0.1 })
  const citationCalls: string[] = []
  const service = new MappingService({
    store: lib.store,
    cache: lib.cache,
    emit: () => void changes++,
    machine: 'machine-a',
    now: () => new Date('2026-10-12T10:00:00.000Z'),
    randomHex: (digits) => (++n).toString(16).padStart(digits, '0'),
    library: lib.library,
    openalex: new OpenAlexSearch(new HttpClient({ fetch: lib.fetch, sleep: async () => {} })),
    citations: opts.citations ?? {
      fetch: async (id) => void citationCalls.push(`references:${id}`),
      fetchCitedBy: async (id) => void citationCalls.push(`cited_by:${id}`)
    },
    suggester: new ScreeningSuggester({
      store: lib.store,
      cache: lib.cache,
      provider,
      budget,
      ledger,
      startTools: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't', calls: () => [], close: async () => undefined })
    }),
    costs: { estimate: (op) => budget.currentEstimate(op), limits: () => limitsFromConfig(lib.store.config.llm), monthSpent: () => ledger.monthTotal() },
    enqueue: (spec) => queued.push(spec),
    pauseMs: 0
  })
  return { ...lib, service, provider, queued, citationCalls, changes: () => changes }
}
