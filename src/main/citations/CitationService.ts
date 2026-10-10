import { randomUUID } from 'node:crypto'
import type { JobSpec, JobType } from '../../shared/jobs'
import { OPENALEX_ID, type CandidateList, type CandidateQuery, type Citations } from '../../shared/relations'
import type { Paper } from '../../shared/schemas'
import type { IndexCache } from '../cache/IndexCache'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import type { ProjectStore } from '../project/ProjectStore'
import { computeCandidates, type CandidateInput } from './candidates'
import type { OpenAlexCitations, WorkCitations } from './OpenAlexCitations'

/** 20 pages of 100: enough for any paper of a thesis library, and a bound on the daily budget. */
const MAX_CITING_PAGES = 20
/** Metadata fetched per candidates request (10 batches). */
const METADATA_LIMIT = 1000
const DEFAULT_PAUSE_MS = 150

export interface CitationServiceDeps {
  store: ProjectStore
  cache: IndexCache
  openalex: OpenAlexCitations
  reindex: (id: string) => Promise<void>
  emit: () => void
  enqueue: (spec: JobSpec) => number
  cancelQueued: (types: JobType[]) => number
  /** Pause before each OpenAlex request; tests pass 0. */
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

/** Citations from OpenAlex: references in paper.yaml, incoming citations and candidate metadata in the cache. */
export class CitationService {
  private readonly candidateRuns = new Map<string, Promise<CandidateList>>()

  constructor(private readonly deps: CitationServiceDeps) {}

  async fetch(paperId: string, signal?: AbortSignal): Promise<{ paperId: string; message: 'citations_updated' | 'citations_unresolved' }> {
    const { store } = this.deps
    try {
      const read = await store.readPaper(paperId)
      if (!read.ok) throw new UserFacingError('file_problem')
      const work = await this.resolve(read.value, signal)
      signal?.throwIfAborted()
      const fetched_at = this.now()
      const citations: Citations = work
        ? { source: 'openalex', fetched_at, openalex_id: work.openalexId, references: work.references, cited_by_count: work.citedByCount }
        : { source: 'openalex', fetched_at, references: [], unresolved: true }
      await store.writePaper({ ...read.value, citations }, read.hash)
      await this.deps.reindex(paperId)
      this.deps.emit()
      return { paperId, message: work ? 'citations_updated' : 'citations_unresolved' }
    } catch (error) {
      throw this.failure(error, signal)
    }
  }

  async fetchCitedBy(paperId: string, signal?: AbortSignal): Promise<{ paperId: string; message: 'cited_by_updated' }> {
    const { cache, openalex } = this.deps
    try {
      const id = cache.relationRows().find((r) => r.id === paperId)?.openalex_id
      if (!id) throw new UserFacingError('no_identifier')
      const citing: string[] = []
      let cursor: string | null = '*'
      for (let page = 0; cursor && page < MAX_CITING_PAGES; page++) {
        await this.pause()
        signal?.throwIfAborted()
        const result = await openalex.citingPage(id, cursor, signal)
        citing.push(...result.ids)
        cursor = result.next
      }
      cache.setIncoming(paperId, citing, this.now())
      this.deps.emit()
      return { paperId, message: 'cited_by_updated' }
    } catch (error) {
      throw this.failure(error, signal)
    }
  }

  /** Queues a citations job for each paper (all when `ids` is omitted); returns how many were queued. */
  requestUpdate(ids?: string[]): number {
    const { cache } = this.deps
    const batchId = randomUUID()
    const rows = ids ? ids.flatMap((id) => cache.getPaper(id) ?? []) : cache.listPapers()
    let count = 0
    for (const row of rows) {
      if (row.problem || cache.hasActiveJob('citations', row.id)) continue
      this.deps.enqueue({ type: 'citations', paperId: row.id, batchId })
      count++
    }
    return count
  }

  /** "Buscar quién cita a mis papers": one cited_by job per paper with an OpenAlex work. */
  requestCitedBy(): number {
    const { cache } = this.deps
    const batchId = randomUUID()
    let count = 0
    for (const row of cache.relationRows()) {
      if (row.citations_status !== 'ok' || !row.openalex_id || cache.hasActiveJob('cited_by', row.id)) continue
      this.deps.enqueue({ type: 'cited_by', paperId: row.id, batchId })
      count++
    }
    return count
  }

  /** After an ingest or a metadata update: fetch citations unless they are already there. */
  autoAfterIngest(paperId: string): void {
    const { cache } = this.deps
    const row = cache.getPaper(paperId)
    if (!row || row.problem || row.citations_status === 'ok' || cache.hasActiveJob('citations', paperId)) return
    this.deps.enqueue({ type: 'citations', paperId })
  }

  /** Simultaneous calls with the same query (e.g. several refreshes in a row) share one run. */
  candidates(query: CandidateQuery, signal?: AbortSignal): Promise<CandidateList> {
    const key = JSON.stringify(query)
    const pending = this.candidateRuns.get(key)
    if (pending) return pending
    const run = this.computeCandidates(query, signal).finally(() => this.candidateRuns.delete(key))
    this.candidateRuns.set(key, run)
    return run
  }

  private async computeCandidates(query: CandidateQuery, signal?: AbortSignal): Promise<CandidateList> {
    const { cache, openalex } = this.deps
    const base = this.candidateInput()
    // Without metadata the DOI exclusion cannot apply yet: this is the superset whose metadata is needed.
    const ids = computeCandidates(base, query).map((c) => c.openalexId)
    const known = cache.externalWorks(ids)
    const missing = ids.filter((id) => !known.has(id)).slice(0, METADATA_LIMIT)
    let metadataError: string | null = null
    if (missing.length) {
      try {
        const fetched = await openalex.worksByIds(missing, signal)
        const returned = new Set(fetched.map((w) => w.openalexId))
        // Works OpenAlex no longer returns (deleted or merged) are stored empty so they are not requested on every refresh.
        const gone = missing
          .filter((id) => !returned.has(id))
          .map((openalexId) => ({ openalexId, title: null, year: null, authors: '', doi: null, citedByCount: null }))
        cache.upsertExternalWorks([...fetched, ...gone], this.now())
      } catch (error) {
        metadataError = toUserFacing(error).code
      }
    }
    // With the metadata, a candidate's DOI may reveal it is already in the library.
    return { candidates: computeCandidates({ ...base, works: cache.externalWorks(ids) }, query), metadataError }
  }

  async dismiss(openalexId: string): Promise<void> {
    if (!OPENALEX_ID.test(openalexId)) throw new UserFacingError('invalid_identifier')
    const { store } = this.deps
    const dismissed = store.config.snowball.dismissed
    if (dismissed.includes(openalexId)) return
    await store.updateConfig({ snowball: { dismissed: [...dismissed, openalexId].sort() } })
    this.deps.emit()
  }

  /** "Agregar": a regular ingest, by DOI when the candidate has one. */
  add(openalexId: string): void {
    if (!OPENALEX_ID.test(openalexId)) throw new UserFacingError('invalid_identifier')
    const work = this.deps.cache.externalWorks([openalexId]).get(openalexId)
    this.deps.enqueue({ type: 'ingest_identifier', input: work?.doi ?? openalexId })
  }

  /** Everything but the metadata, which computeCandidates gets from the cache. */
  private candidateInput(): CandidateInput {
    const { cache, store } = this.deps
    const rows = cache.relationRows()
    // Incoming citations of papers with a problem stay in the cache, but only readable papers count (as with references).
    const readable = new Set(rows.map((r) => r.id))
    return {
      references: cache.citationEdges(),
      incoming: cache.incomingEdges().filter((e) => readable.has(e.paperId)),
      library: rows.map((r) => ({ id: r.id, openalexId: r.openalex_id, doi: r.doi })),
      dismissed: new Set(store.config.snowball.dismissed),
      works: new Map()
    }
  }

  private async resolve(paper: Paper, signal?: AbortSignal): Promise<WorkCitations | null> {
    const { openalex } = this.deps
    const known = paper.citations?.openalex_id ?? paper.identifiers.openalex
    if (known) {
      await this.pause()
      const work = await openalex.work(known, signal)
      if (work) return work
    }
    if (paper.identifiers.doi) {
      await this.pause()
      return openalex.workByDoi(paper.identifiers.doi, signal)
    }
    // Web pages are not in OpenAlex: a paid search would only find false matches.
    if (paper.kind === 'web') return null
    await this.pause()
    const id = await openalex.findByTitle(paper.title, paper.year ?? null, signal)
    if (!id) return null
    await this.pause()
    return openalex.work(id, signal)
  }

  private failure(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return error
    const userFacing = toUserFacing(error)
    if (userFacing.code === 'openalex_limit') this.deps.cancelQueued(['citations', 'cited_by'])
    return userFacing
  }

  private async pause(): Promise<void> {
    const ms = this.deps.pauseMs ?? DEFAULT_PAUSE_MS
    if (ms > 0) await (this.deps.sleep ?? ((t: number) => new Promise<void>((resolve) => setTimeout(resolve, t))))(ms)
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }
}
