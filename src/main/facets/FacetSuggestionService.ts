import { randomUUID } from 'node:crypto'
import type {
  FacetSuggestion,
  FacetSuggestionList,
  FacetSuggestionsFile,
  FacetSuggestionsFileState,
  FacetSuggestionStatus,
  FacetSuggestPlan,
  SuggestionEdit
} from '../../shared/facetSuggestions'
import type { JobSpec } from '../../shared/jobs'
import type { ExtractionForm, LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { ConflictError, type ReadResult } from '../project/errors'
import { EMPTY_FACET_SUGGESTIONS } from '../project/facetSuggestionsFile'
import type { ProjectStore } from '../project/ProjectStore'
import { loadForm } from '../summary/extractionForm'
import { InvalidEdit } from '../summary/merge'
import type { ExtractionChange, SummaryService } from '../summary/SummaryService'
import { computeFacetOverview, libraryExtractions, type FacetOverview } from './facetOverview'
import { acceptance, replaceUnreviewed, suggestionValidity, withEdit } from './facetSuggestionMerge'
import type { FacetSuggester } from './FacetSuggester'

const UP_TO_DATE = new Set(['generated', 'reviewed'])
const MAX_UNDO = 50

type Undo =
  | { kind: 'status'; before: FacetSuggestion; after: FacetSuggestion }
  | { kind: 'accept'; before: FacetSuggestion; after: FacetSuggestion; formBefore: ExtractionForm; formAfter: ExtractionForm; changes: ExtractionChange[] }

/** One decision: the suggestion as it is written, its undo, and how to take back what it did outside the file. */
interface Decision {
  after: FacetSuggestion
  undo: Undo
  /** Called when the suggestion file cannot be written, so the decision does not stay half done. */
  rollback?: () => Promise<void>
}

export interface FacetSuggestionServiceDeps {
  store: ProjectStore
  cache: IndexCache
  summaries: SummaryService
  suggester: FacetSuggester
  budget: BudgetGuard
  /** The suggestions changed (the session's 'facets' event). */
  emit: () => void
  enqueue: (spec: JobSpec) => number
  /** The saved form changed (an acceptance or its undo): project.yaml was rewritten. */
  formChanged?: () => void
  now?: () => Date
}

/** Facet suggestions of one project: facet-suggestions.yaml, runs, decisions, undo and the automatic trigger. */
export class FacetSuggestionService {
  private file: FacetSuggestionsFileState = { status: 'missing' }
  /** The last readable content of the file. */
  private current: FacetSuggestionsFile = EMPTY_FACET_SUGGESTIONS
  /** Hash of the file as of the last read (null: missing; undefined: never read). */
  private indexedHash: string | null | undefined = undefined
  /** Undo token → decision; tokens never leave the main process with the data. */
  private readonly undo = new Map<string, Undo>()
  /** Decisions and writes of the file run one after another. */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * The UTC day the automatic trigger last queued a run: a run cancelled while still queued never reaches run(), so
   * last_run alone would let the next summary queue it again the same day.
   */
  private autoDay: string | null = null

  constructor(private readonly deps: FacetSuggestionServiceDeps) {}

  async reindex(): Promise<void> {
    this.apply(await this.deps.store.readFacetSuggestions())
  }

  /** For the watcher: reads again only when the file differs from the last read, so our own writes do nothing. */
  reindexIfChanged(): Promise<boolean> {
    return this.serialized(async () => {
      const read = await this.deps.store.readFacetSuggestions()
      if (this.indexedHash !== undefined && (read?.hash ?? null) === this.indexedHash) return false
      this.apply(read)
      return true
    })
  }

  /** Every suggestion with whether it still applies to the current form (recomputed each time). */
  async list(): Promise<FacetSuggestionList> {
    const load = loadForm(this.deps.store.config.extraction_form)
    const form = load.status === 'ok' ? load.form : null
    const overview = form ? await this.overview(form) : null
    const suggestions = this.current.suggestions.map((suggestion) => ({
      suggestion,
      // Without a valid form nothing can be accepted anyway: accept answers invalid_form.
      validity: form && overview ? suggestionValidity(suggestion, form, overview) : ('ok' as const)
    }))
    return {
      file: this.file,
      suggestions,
      pending: suggestions.filter((v) => v.suggestion.status === 'suggested').length,
      running: this.deps.cache.hasActiveJobOfType('suggest_facets'),
      lastRun: this.current.last_run ?? null
    }
  }

  /** «Sugerir facetas»: the learned estimate, the run's own cap and the papers it looks at. */
  plan(): FacetSuggestPlan {
    return {
      estimateUsd: this.deps.budget.currentEstimate('suggest_facets'),
      capUsd: this.deps.store.config.llm.budget.per_facet_suggestion_usd,
      papers: this.deps.cache.listPapers().filter((r) => !r.problem).length
    }
  }

  /** Queues a run unless one is queued or running. */
  async request(opts: { auto?: boolean; batchId?: string; model?: LlmModel } = {}): Promise<void> {
    this.assertReadable()
    if (loadForm(this.deps.store.config.extraction_form).status !== 'ok') throw new UserFacingError('invalid_form')
    if (this.deps.cache.hasActiveJobOfType('suggest_facets')) return
    this.deps.enqueue({
      type: 'suggest_facets',
      ...(opts.auto ? { auto: true } : {}),
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      ...(opts.model ? { model: opts.model } : {})
    })
  }

  /** The suggest_facets job: one agent run; its suggestions replace the ones still to review. */
  async run(opts: { batchId?: string; model?: LlmModel; signal?: AbortSignal }): Promise<{ message: 'facets_suggested' }> {
    const at = this.nowIso()
    const summarized = this.summarizedCount()
    try {
      const { file } = await this.readFresh()
      const result = await this.deps.suggester.suggest({ existing: file.suggestions, batchId: opts.batchId, model: opts.model, signal: opts.signal })
      await this.mutateFile((f) => ({ ...replaceUnreviewed(f, result.suggestions), last_run: { at, ok: true, summarized, model: result.model } }))
      return { message: 'facets_suggested' }
    } catch (error) {
      // Recorded (also for a cancelled run: any run of the day counts) so the automatic trigger waits for the next day;
      // the count of the last successful run stays.
      await this.mutateFile((f) => ({ ...f, last_run: { at, ok: false, summarized: f.last_run?.summarized ?? 0 } })).catch((e: unknown) =>
        console.error('facet-suggestions.yaml', e)
      )
      if (opts.signal?.aborted) throw error
      throw toUserFacing(error)
    } finally {
      if (!opts.signal?.aborted) this.deps.emit()
    }
  }

  /**
   * «Aceptar» (or «Editar y aceptar» with `edit`): changes the form, and the papers' proposals for values and aliases.
   * All or nothing: the papers and the form are changed first; if the suggestion file then cannot be written, they are
   * put back, so a suggestion is never accepted without its form change, nor the other way round. If that put-back
   * itself fails (it is hash-checked, so it never clobbers a newer change), the error is logged and the suggestion stays
   * `suggested`; it then shows as no longer applicable and can be rejected.
   */
  accept(id: string, edit?: SuggestionEdit): Promise<string> {
    return this.decide(async (file) => {
      const before = file.suggestions.find((s) => s.id === id)
      if (!before || before.status !== 'suggested') throw new InvalidEdit(`Suggestion ${id} is not waiting for review`)
      const load = loadForm(this.deps.store.config.extraction_form)
      if (load.status !== 'ok') throw new UserFacingError('invalid_form')
      const proposal = withEdit(before, edit)
      // Checked before anything is written: an outdated suggestion changes nothing.
      if (suggestionValidity(proposal, load.form, await this.overview(load.form)) !== 'ok') throw new UserFacingError('suggestion_outdated')
      const plan = acceptance(proposal, load.form)
      let changes: ExtractionChange[]
      try {
        // `base`: a form saved meanwhile (the form editor) is never overwritten.
        changes = await this.deps.summaries.changeForm(plan.form, plan.rewrite, load.form)
      } catch (error) {
        if (error instanceof InvalidEdit) throw new UserFacingError('suggestion_outdated', { cause: error })
        throw error
      }
      const after: FacetSuggestion = { ...proposal, status: 'accepted', updated_at: this.nowIso() }
      return {
        after,
        undo: { kind: 'accept', before, after, formBefore: load.form, formAfter: plan.form, changes },
        rollback: async () => {
          await this.deps.summaries.undoFormChange(load.form, plan.form, changes)
        }
      }
    })
  }

  reject(id: string): Promise<string> {
    return this.setStatus(id, 'suggested', 'rejected')
  }

  /** A rejected suggestion back among the ones to review. */
  restore(id: string): Promise<string> {
    return this.setStatus(id, 'rejected', 'suggested')
  }

  /**
   * Each token undoes its decision once, and only while the suggestion (and, for an acceptance, the form and the papers
   * it rewrote) is still what that decision left. A refused undo spends the token; a transient failure keeps it. Undoing
   * an acceptance is all or nothing too: if the suggestion file cannot be written, the acceptance is applied again.
   */
  async revert(undoToken: string): Promise<void> {
    const undo = this.undo.get(undoToken)
    if (!undo) throw new InvalidEdit('Nothing to undo')
    try {
      await this.serialized(async () => {
        const { file, hash } = await this.readFresh()
        const now = file.suggestions.find((s) => s.id === undo.after.id)
        if (!now || now.status !== undo.after.status || now.updated_at !== undo.after.updated_at) throw new InvalidEdit('The suggestion changed since')
        const reverse = undo.kind === 'accept' ? await this.deps.summaries.undoFormChange(undo.formBefore, undo.formAfter, undo.changes) : null
        const restored: FacetSuggestion = { ...undo.before, updated_at: this.nowIso() }
        try {
          await this.deps.store.writeFacetSuggestions({ ...file, suggestions: file.suggestions.map((s) => (s.id === restored.id ? restored : s)) }, hash)
        } catch (error) {
          if (undo.kind === 'accept' && reverse) {
            try {
              // Back to what the acceptance left; the token keeps working with the hashes of this rewrite.
              const again = await this.deps.summaries.undoFormChange(undo.formAfter, undo.formBefore, reverse)
              const hashes = new Map(again.map((c) => [c.paperId, c.afterHash]))
              undo.changes = undo.changes.map((c) => ({ ...c, afterHash: hashes.get(c.paperId) ?? c.afterHash }))
            } catch (redoError) {
              console.error('facet suggestion undo: could not apply the acceptance again', redoError)
              // The acceptance is gone from the form but the suggestion still says accepted: the token cannot help any more.
              this.undo.delete(undoToken)
            }
          }
          throw error
        }
        // Written: a failing re-read must not undo the decision (the watcher reads the file again later).
        await this.reindexLogged()
      })
    } catch (error) {
      if (error instanceof InvalidEdit) this.undo.delete(undoToken)
      throw error
    }
    this.undo.delete(undoToken)
    this.deps.emit()
    if (undo.kind === 'accept') this.deps.formChanged?.()
  }

  /**
   * «Sugerir facetas automáticamente», after each summary: once `auto_suggest_facets_after` papers got an up-to-date
   * summary since the last successful run, at most once per UTC day (a run that failed today waits for tomorrow).
   * It never accepts anything.
   */
  async autoAfterSummary(): Promise<void> {
    const { store, cache } = this.deps
    const llm = store.config.llm
    if (!llm.auto_suggest_facets) return
    if (this.file.status === 'conflict' || this.file.status === 'invalid') return
    if (loadForm(store.config.extraction_form).status !== 'ok') return
    if (cache.hasActiveJobOfType('suggest_facets')) return
    const day = this.nowIso().slice(0, 10)
    const last = this.current.last_run
    if (this.autoDay === day || (last && last.at.slice(0, 10) === day)) return
    if (this.summarizedCount() - (last?.summarized ?? 0) < llm.auto_suggest_facets_after) return
    this.autoDay = day
    // The day's automatic batch: its cap is shared with the automatic relation suggestions.
    await this.request({ auto: true, batchId: `auto-${day}` })
  }

  private setStatus(id: string, from: FacetSuggestionStatus, to: FacetSuggestionStatus): Promise<string> {
    return this.decide(async (file) => {
      const before = file.suggestions.find((s) => s.id === id)
      if (!before || before.status !== from) throw new InvalidEdit(`Suggestion ${id} is not ${from}`)
      const after: FacetSuggestion = { ...before, status: to, updated_at: this.nowIso() }
      return { after, undo: { kind: 'status', before, after } }
    })
  }

  /** One decision, computed and written while no other decision or write of the file runs; returns its undo token. */
  private async decide(fn: (file: FacetSuggestionsFile) => Promise<Decision>): Promise<string> {
    const decided = await this.serialized(async () => {
      const { file, hash } = await this.readFresh()
      const out = await fn(file)
      try {
        await this.deps.store.writeFacetSuggestions({ ...file, suggestions: file.suggestions.map((s) => (s.id === out.after.id ? out.after : s)) }, hash)
      } catch (error) {
        if (out.rollback) await out.rollback().catch((e: unknown) => console.error('facet suggestion: could not take back a decision', e))
        throw error
      }
      // Written: a failing re-read must not take the decision back (the watcher reads the file again later).
      await this.reindexLogged()
      return out
    })
    this.deps.emit()
    if (decided.undo.kind === 'accept') this.deps.formChanged?.()
    return this.remember(decided.undo)
  }

  private apply(read: ReadResult<FacetSuggestionsFile> | null): void {
    this.indexedHash = read?.hash ?? null
    if (read === null) {
      this.file = { status: 'missing' }
      this.current = EMPTY_FACET_SUGGESTIONS
      return
    }
    if (!read.ok) {
      this.file = read.problem.kind === 'conflict_markers' ? { status: 'conflict' } : { status: 'invalid', message: read.problem.message }
      return
    }
    this.file = { status: 'ok' }
    this.current = read.value
  }

  private assertReadable(): void {
    if (this.file.status === 'conflict' || this.file.status === 'invalid') throw new UserFacingError('facet_suggestions_conflict')
  }

  /** The file as it is on disk now, with its hash; a conflicted or invalid file refuses (and is reported by list()). */
  private async readFresh(): Promise<{ file: FacetSuggestionsFile; hash: string | null }> {
    const read = await this.deps.store.readFacetSuggestions()
    if (read && !read.ok) {
      this.apply(read)
      throw new UserFacingError('facet_suggestions_conflict')
    }
    return { file: read?.ok ? read.value : EMPTY_FACET_SUGGESTIONS, hash: read?.hash ?? null }
  }

  private async reindexLogged(): Promise<void> {
    await this.reindex().catch((error: unknown) => console.error('facet-suggestions.yaml', error))
  }

  private async write(file: FacetSuggestionsFile, hash: string | null): Promise<void> {
    await this.deps.store.writeFacetSuggestions(file, hash)
    await this.reindex()
  }

  /** Reads, transforms and writes the file (hash-checked; one retry on a concurrent change). */
  private mutateFile(fn: (file: FacetSuggestionsFile) => FacetSuggestionsFile): Promise<void> {
    return this.serialized(async () => {
      for (let attempt = 0; ; attempt++) {
        const { file, hash } = await this.readFresh()
        try {
          await this.write(fn(file), hash)
          return
        } catch (error) {
          if (error instanceof ConflictError && attempt === 0) continue
          throw error
        }
      }
    })
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private remember(undo: Undo): string {
    const token = randomUUID()
    this.undo.set(token, undo)
    while (this.undo.size > MAX_UNDO) this.undo.delete(this.undo.keys().next().value!)
    return token
  }

  private async overview(form: ExtractionForm): Promise<FacetOverview> {
    return computeFacetOverview(form, await libraryExtractions(this.deps.store, this.deps.cache))
  }

  /** Readable papers whose summary is up to date. */
  private summarizedCount(): number {
    return this.deps.cache.listPapers().filter((r) => !r.problem && UP_TO_DATE.has(r.summary_status)).length
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }
}
