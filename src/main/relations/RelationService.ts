import { randomUUID } from 'node:crypto'
import type { JobSpec } from '../../shared/jobs'
import type { LlmModel, ReviewItem } from '../../shared/summary'
import type {
  PaperAnalysis,
  PaperRelations,
  RelationChange,
  RelationPlan,
  RelationsFile,
  RelationsFileState,
  RelationStatus,
  RelationType,
  TypedRelation
} from '../../shared/typedRelations'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { ConflictError } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { EMPTY_RELATIONS } from '../project/relationsFile'
import { InvalidEdit } from '../summary/merge'
import { coveredFrom, hasNewCandidates, type CandidateIndex, type RelationCandidate } from './relationCandidates'
import {
  applyChange,
  mergeSuggestions,
  relationReviewItems,
  retype,
  reverse,
  revertChange,
  userKept,
  viewsFor,
  withJustification,
  withStatus
} from './relationMerge'
import type { RelationSuggester } from './RelationSuggester'

/** Only what makes every remaining job of the batch fail too: the quota, or a batch/monthly cap refusing admission. */
const BATCH_STOPPERS = new Set(['llm_quota', 'budget_exceeded'])
const SUMMARIZED = new Set(['generated', 'reviewed'])
const MAX_UNDO = 100

export interface RelationServiceDeps {
  store: ProjectStore
  cache: IndexCache
  suggester: RelationSuggester
  budget: BudgetGuard
  emit: () => void
  enqueue: (spec: JobSpec) => number
  cancelBatch: (batchId: string) => number
  now?: () => Date
}

/** Typed relations of one project: suggestion jobs, batches, review decisions, undo, conflicts and the index of relations.yaml. */
export class RelationService {
  private file: RelationsFileState = { status: 'missing' }
  /** relations.yaml's `analyzed`, as of the last reindex. */
  private analyzed: Record<string, PaperAnalysis> = {}
  /** Hash of the conflicted relations.yaml the last reindex read: the text the user is shown and may resolve. */
  private conflictHash: string | null = null
  /** Undo token → decision; tokens never leave the main process with the relation data. */
  private readonly undo = new Map<string, RelationChange>()
  /** Writes of relations.yaml run one after another. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: RelationServiceDeps) {}

  get suggester(): RelationSuggester {
    return this.deps.suggester
  }

  /** Mirrors relations.yaml into the index; an unreadable file keeps the previous rows and is reported by fileState(). */
  async reindex(): Promise<void> {
    const read = await this.deps.store.readRelations()
    this.conflictHash = read && !read.ok && read.problem.kind === 'conflict_markers' ? read.hash : null
    if (read === null) {
      this.file = { status: 'missing' }
      this.analyzed = {}
      this.deps.cache.replaceTypedRelations([])
      return
    }
    if (!read.ok) {
      this.file = read.problem.kind === 'conflict_markers' ? { status: 'conflict' } : { status: 'invalid', message: read.problem.message }
      return
    }
    this.file = { status: 'ok' }
    this.analyzed = read.value.analyzed
    this.deps.cache.replaceTypedRelations(read.value.relations)
  }

  fileState(): RelationsFileState {
    return this.file
  }

  /** A candidate appeared that its last analysis did not see (pairs already analyzed from the other paper do not count). */
  needsAnalysis(paperId: string, index?: CandidateIndex): boolean {
    return hasNewCandidates(
      this.unanalyzedCandidates(paperId, index).map((c) => c.id),
      this.analyzed[paperId]
    )
  }

  forPaper(paperId: string): PaperRelations {
    const { cache, suggester } = this.deps
    const index = suggester.candidateIndex()
    const papers = new Map(cache.relationRows().map((r) => [r.id, { title: r.title, year: r.year }]))
    return {
      ...viewsFor(cache.typedRelations(paperId), paperId, papers),
      candidates: suggester.candidatesFor(paperId, index).length,
      needsAnalysis: this.needsAnalysis(paperId, index),
      file: this.file
    }
  }

  async run(
    paperId: string,
    opts: { force?: boolean; batchId?: string; model?: LlmModel; signal?: AbortSignal }
  ): Promise<{ paperId: string; message: 'relations_suggested' | 'relations_no_candidates' }> {
    try {
      const file = await this.currentFile()
      const result = await this.deps.suggester.suggest({
        paperId,
        // Only this paper's relations: the model never sees (or repeats) the rest of the library.
        existing: file.relations.filter((r) => r.from === paperId || r.to === paperId),
        skip: opts.force ? undefined : coveredFrom(file.analyzed, paperId),
        batchId: opts.batchId,
        model: opts.model,
        signal: opts.signal
      })
      const at = this.now()
      await this.mutateFile((f) => ({
        ...f,
        relations: result.candidates.length > 0 ? mergeSuggestions(f.relations, paperId, result.relations) : f.relations,
        analyzed: { ...f.analyzed, [paperId]: { candidates: result.candidates.map((c) => c.id), at } }
      }))
      return { paperId, message: result.candidates.length > 0 ? 'relations_suggested' : 'relations_no_candidates' }
    } catch (error) {
      if (opts.signal?.aborted) throw error
      const facing = toUserFacing(error)
      if (opts.batchId && BATCH_STOPPERS.has(facing.code)) this.deps.cancelBatch(opts.batchId)
      throw facing
    } finally {
      if (!opts.signal?.aborted) this.deps.emit()
    }
  }

  /** Queues one analysis (unless already queued). `force`: the user asked, so pairs analyzed from the other side are included. */
  async request(paperId: string, opts: { model?: LlmModel; force?: boolean; batchId?: string } = {}): Promise<void> {
    this.assertWritable()
    if (this.deps.cache.getPaper(paperId)?.text_status !== 'ok') throw new UserFacingError('no_text')
    if (this.deps.cache.hasActiveJob('suggest_relations', paperId)) return
    this.deps.enqueue({
      type: 'suggest_relations',
      paperId,
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.force ? { force: true } : {})
    })
  }

  async plan(ids?: string[]): Promise<RelationPlan> {
    const count = this.eligibleIds(ids).length
    return { count, estimateUsd: count * this.deps.budget.currentEstimate('suggest_relations'), batchLimitUsd: this.deps.store.config.llm.budget.per_batch_usd }
  }

  async requestBatch(opts: { ids?: string[]; model?: LlmModel } = {}): Promise<{ batchId: string; count: number }> {
    this.assertWritable()
    const batchId = randomUUID()
    const ids = this.eligibleIds(opts.ids)
    for (const paperId of ids) this.deps.enqueue({ type: 'suggest_relations', paperId, batchId, ...(opts.model ? { model: opts.model } : {}) })
    return { batchId, count: ids.length }
  }

  /** "Sugerir relaciones automáticamente": once a paper has a summary and citations, and a new candidate; one batch per UTC day. */
  async autoAfter(paperId: string): Promise<void> {
    const { store, cache } = this.deps
    if (!store.config.llm.auto_suggest_relations) return
    const row = cache.getPaper(paperId)
    if (!row || row.problem || row.text_status !== 'ok' || row.citations_status !== 'ok' || !SUMMARIZED.has(row.summary_status)) return
    if (this.file.status === 'conflict' || this.file.status === 'invalid') return
    if (!this.needsAnalysis(paperId)) return
    await this.request(paperId, { batchId: `auto-${this.now().slice(0, 10)}` })
  }

  setStatus(id: string, status: RelationStatus): Promise<string> {
    return this.decide(id, (r) => {
      if (r.status === status) throw new InvalidEdit(`Relation ${id} is already ${status}`)
      // Put back by the user: a later analysis of its paper must not drop it.
      return userKept(withStatus(r, status, this.now()))
    })
  }

  changeType(id: string, type: RelationType): Promise<string> {
    return this.decide(id, (r) => {
      if (r.type === type) throw new InvalidEdit(`Relation ${id} already has type ${type}`)
      return retype(r, type, this.now())
    })
  }

  reverse(id: string): Promise<string> {
    return this.decide(id, (r) => reverse(r, this.now()))
  }

  editJustification(id: string, text: string): Promise<string> {
    return this.decide(id, (r) => withJustification(r, text, this.now()))
  }

  /** Each token undoes its decision once, and only while the relation is still what that decision left. */
  async revert(undoToken: string): Promise<void> {
    const change = this.undo.get(undoToken)
    if (!change) throw new InvalidEdit('Nothing to undo')
    try {
      // Undoing a confirm or a rejection leaves a suggestion the user chose to keep.
      await this.mutate((list) => revertChange(list, change, this.now()).map((r) => (r.id === change.before.id ? userKept(r) : r)))
    } finally {
      this.undo.delete(undoToken)
    }
    this.deps.emit()
  }

  /** Resolves the conflicted text the last reindex read (what the user saw); a newer file is re-read and refused. */
  async resolveConflict(): Promise<{ dropped: number }> {
    try {
      return await this.serialized(async () => {
        if (this.conflictHash === null) throw new UserFacingError('relations_conflict')
        try {
          const resolved = await this.deps.store.resolveRelationsConflict(this.conflictHash)
          if (!resolved) throw new UserFacingError('relations_conflict')
          return resolved
        } finally {
          await this.reindex()
        }
      })
    } catch (error) {
      throw toUserFacing(error)
    } finally {
      this.deps.emit()
    }
  }

  reviewItems(rows: { id: string; title: string }[]): ReviewItem[] {
    return relationReviewItems(this.deps.cache.typedRelations(), rows)
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }

  private assertWritable(): void {
    if (this.file.status === 'conflict' || this.file.status === 'invalid') throw new UserFacingError('relations_conflict')
  }

  /** Candidates a non-forced analysis would look at: pairs already analyzed from the other paper are left out. */
  private unanalyzedCandidates(paperId: string, index?: CandidateIndex): RelationCandidate[] {
    const covered = coveredFrom(this.analyzed, paperId)
    return this.deps.suggester.candidatesFor(paperId, index).filter((c) => !covered.has(c.id))
  }

  /** The candidate index is built once for the whole list. */
  private eligibleIds(ids?: string[]): string[] {
    const { cache, suggester } = this.deps
    const index = suggester.candidateIndex()
    const rows = ids ? ids.flatMap((id) => cache.getPaper(id) ?? []) : cache.listPapers()
    return rows.filter((r) => !r.problem && r.text_status === 'ok' && !cache.hasActiveJob('suggest_relations', r.id) && this.needsAnalysis(r.id, index)).map((r) => r.id)
  }

  private async currentFile(): Promise<RelationsFile> {
    const read = await this.deps.store.readRelations()
    if (read && !read.ok) throw new UserFacingError('relations_conflict')
    return read?.ok ? read.value : EMPTY_RELATIONS
  }

  private remember(change: RelationChange): string {
    const token = randomUUID()
    this.undo.set(token, change)
    while (this.undo.size > MAX_UNDO) this.undo.delete(this.undo.keys().next().value!)
    return token
  }

  private async decide(id: string, next: (r: TypedRelation) => TypedRelation): Promise<string> {
    const out: { change?: RelationChange } = {}
    await this.mutate((list) => {
      const before = list.find((r) => r.id === id)
      if (!before) throw new InvalidEdit(`Unknown relation ${id}`)
      const change = { before, after: next(before) }
      out.change = change
      return applyChange(list, change)
    })
    this.deps.emit()
    return this.remember(out.change!)
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private mutate(fn: (list: TypedRelation[]) => TypedRelation[]): Promise<void> {
    return this.mutateFile((f) => ({ ...f, relations: fn(f.relations) }))
  }

  /** Reads, transforms and writes relations.yaml (hash-checked; one retry on a concurrent change), then reindexes. */
  private mutateFile(fn: (file: RelationsFile) => RelationsFile): Promise<void> {
    return this.serialized(async () => {
      const { store } = this.deps
      for (let attempt = 0; ; attempt++) {
        const read = await store.readRelations()
        if (read && !read.ok) {
          await this.reindex()
          throw new UserFacingError('relations_conflict')
        }
        const base = read?.ok ? read.value : EMPTY_RELATIONS
        try {
          await store.writeRelations(fn(base), read?.hash ?? null)
          break
        } catch (error) {
          if (error instanceof ConflictError && attempt === 0) continue
          throw error
        }
      }
      await this.reindex()
    })
  }
}
