import { randomUUID } from 'node:crypto'
import type { JobSpec } from '../../shared/jobs'
import {
  FACET_KEY_PATTERN,
  LlmConfigShape,
  SUMMARY_FIELD_KEYS,
  type ExtractionFile,
  type ExtractionForm,
  type FormImpact,
  type FormInfo,
  type LlmConfig,
  type LlmModel,
  type ReviewItem,
  type Section,
  type SummaryFieldKey,
  type SummaryFile,
  type SummaryPlan,
  type ThesisContext,
  ThesisContextSchema
} from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { facetRowsFor } from '../map/facetStats'
import type { ProjectStore } from '../project/ProjectStore'
import { DEFAULT_EXTRACTION_FORM, formHashFor, loadForm, sortKeys, unfilledFacets } from './extractionForm'
import { renderSummaryMarkdown } from './markdown'
import {
  acceptProposed,
  addAlias,
  addFacetValue,
  countPending,
  editFacet,
  editField,
  entryFitsFacet,
  InvalidEdit,
  mapProposed,
  setFacetStatus,
  setFieldStatus,
  setThesisStatus,
  summarySearchText,
  summaryState,
  thesisRelationOutdated,
  verifyAll,
  type FacetPatch
} from './merge'
import { pagesFromChunks } from './paperText'
import type { FacetFiller } from './FacetFiller'
import type { Summarizer } from './Summarizer'
import { editThesisRelation, hasThesisContext, thesisHash, type ThesisPatch } from './thesis'

const BATCH_STOPPERS = new Set(['llm_quota', 'budget_exceeded'])
const ELIGIBLE = new Set(['none', 'stale', 'failed'])
const UP_TO_DATE = new Set(['generated', 'reviewed'])
/** Undo tokens kept at most; the oldest is dropped first. */
const MAX_UNDO = 100

/** Brings the summary columns of one cache row up to date (status, pending count, unfilled facets, searchable text). */
export async function indexSummary(store: ProjectStore, cache: IndexCache, id: string): Promise<void> {
  const s = await store.readSummary(id)
  const e = await store.readExtraction(id)
  const summary = s?.ok ? s.value : null
  const extraction = e?.ok ? e.value : null
  const load = loadForm(store.config.extraction_form)
  const form = load.status === 'ok' ? load : null
  const facetDefs = form ? form.form.facets : null
  const facetKeys = facetDefs ? facetDefs.map((f) => f.key) : null
  const currentThesis = currentThesisHash(store)
  const status = summaryState({
    facetKeys,
    facetDefs,
    summary,
    extraction,
    // Per paper: a facet the paper has no entry for (added after it was summarized) leaves it up to date, only unfilled.
    formHash: form ? (extraction ? formHashFor(form.form, Object.keys(extraction.facets)) : form.hash) : null,
    thesisHash: currentThesis,
    textChars: cache.textChars(id),
    maxChars: store.config.llm.max_input_chars,
    error: cache.summaryError(id)
  })
  cache.setSummaryState(
    id,
    status,
    countPending(summary, extraction, facetKeys, currentThesis, facetDefs),
    summarySearchText(summary, extraction),
    summary?.generated.model ?? null,
    // Only an up-to-date summary has unfilled facets: a stale one is regenerated whole, never filled.
    form && summary && extraction && (status === 'generated' || status === 'reviewed') ? unfilledFacets(form.form, extraction).length : 0
  )
  // The map's charts, lenses and similarity read facet values from the index, never from the files.
  cache.setFacets(id, facetRowsFor(extraction, facetDefs), extraction?.thesis_relation?.score ?? null)
}

/** Hash of the project's thesis context; null when there is none. */
export function currentThesisHash(store: ProjectStore): string | null {
  return hasThesisContext(store.config.thesis) ? thesisHash(store.config.thesis) : null
}

export interface SummaryServiceDeps {
  store: ProjectStore
  cache: IndexCache
  summarizer: Summarizer
  /** Fills facets added to the form after a paper was summarized. */
  filler: FacetFiller
  budget: BudgetGuard
  ledger: CostLedger
  reindex: (id: string) => Promise<void>
  emit: () => void
  enqueue: (spec: JobSpec) => number
  cancelBatch: (batchId: string) => number
  /** After refreshStates re-indexed every paper's summary state and facets. */
  statesRefreshed?: () => void
}

/** Both files of a paper as read from disk, with the hashes needed to write them back. */
interface PaperFiles {
  title: string
  summary: { value: SummaryFile; hash: string } | null
  extraction: { value: ExtractionFile; hash: string } | null
}

/** One paper's classification before a form change rewrote it, and its hash after: enough to undo exactly that change. */
export interface ExtractionChange {
  paperId: string
  before: ExtractionFile
  afterHash: string
}

/** One paper a form change rewrites: its files as read, and the classification it gets. */
interface PaperRewrite {
  id: string
  files: PaperFiles
  next: ExtractionFile
}

/** Hashes of what saveOrRestore wrote (summary: null when the paper has no summary.md). */
interface SavedHashes {
  extraction: string
  summary: string | null
}

/** Hashes of the files a save wrote (null: that file was not written). */
interface WrittenHashes {
  summary: string | null
  extraction: string | null
}

/**
 * What «Deshacer» needs: a paper's files as they were before a review change and their hashes after it, or a form change
 * with every paper it rewrote (undone by undoFormChange, all or nothing).
 */
type SummaryUndo =
  | { kind: 'paper'; paperId: string; before: { summary?: SummaryFile; extraction?: ExtractionFile }; after: WrittenHashes }
  | { kind: 'form'; formBefore: ExtractionForm; formAfter: ExtractionForm; changes: ExtractionChange[] }

/** Summaries of one project: jobs, batches, review edits and proposed values. */
export class SummaryService {
  /** Undo tokens of review changes and proposed values; they never leave the main process with the data. */
  private readonly undo = new Map<string, SummaryUndo>()

  constructor(private readonly deps: SummaryServiceDeps) {}

  /** The valid form; a missing one is replaced by the default draft, an invalid one blocks summaries. */
  async ensureForm(): Promise<ExtractionForm> {
    const load = loadForm(this.deps.store.config.extraction_form)
    if (load.status === 'ok') return load.form
    if (load.status === 'invalid') throw new UserFacingError('invalid_form')
    await this.deps.store.updateConfig({ extraction_form: DEFAULT_EXTRACTION_FORM })
    await this.refreshStates()
    return DEFAULT_EXTRACTION_FORM
  }

  async run(paperId: string, opts: { force?: boolean; batchId?: string; model?: LlmModel; signal?: AbortSignal }): Promise<{ paperId: string; message: 'summarized' }> {
    const { cache, summarizer } = this.deps
    try {
      // A summary already made from truncated text was consented to once: regenerating it (alone or in a batch) forces again.
      const force = opts.force || (await this.wasTruncated(paperId))
      await summarizer.summarize({ paperId, ...opts, force })
      cache.setSummaryError(paperId, null)
      return { paperId, message: 'summarized' }
    } catch (error) {
      if (opts.signal?.aborted) throw error
      const code = toUserFacing(error).code
      cache.setSummaryError(paperId, code)
      if (opts.batchId && BATCH_STOPPERS.has(code)) this.deps.cancelBatch(opts.batchId)
      throw toUserFacing(error)
    } finally {
      if (!opts.signal?.aborted) {
        // A failing reindex must not replace the summary's own outcome.
        await this.deps.reindex(paperId).catch((error: unknown) => console.error('reindex', paperId, error))
        this.deps.emit()
      }
    }
  }

  async request(paperId: string, opts: { force?: boolean; model?: LlmModel } = {}): Promise<void> {
    await this.ensureForm()
    if (this.deps.cache.hasActiveJob('summarize', paperId)) return
    this.deps.enqueue({ type: 'summarize', paperId, ...(opts.force ? { force: true } : {}), ...(opts.model ? { model: opts.model } : {}) })
  }

  /**
   * Papers a batch would summarize: with `ids`, those papers whatever their state; otherwise the ones without an
   * up-to-date summary. Either way a paper over max_input_chars is skipped unless its summary was already forced.
   */
  private async eligibleIds(ids?: string[]): Promise<string[]> {
    const { cache, store } = this.deps
    const rows = ids ? ids.flatMap((id) => cache.getPaper(id) ?? []) : cache.listPapers()
    const eligible: string[] = []
    for (const r of rows) {
      if (r.text_status !== 'ok' || (!ids && !ELIGIBLE.has(r.summary_status)) || cache.hasActiveJob('summarize', r.id)) continue
      if (cache.textChars(r.id) > store.config.llm.max_input_chars && !(await this.wasTruncated(r.id))) continue
      eligible.push(r.id)
    }
    return eligible
  }

  private async wasTruncated(paperId: string): Promise<boolean> {
    const s = await this.deps.store.readSummary(paperId).catch(() => null)
    return Boolean(s?.ok && s.value.generated.truncated)
  }

  /** How many papers a batch over `ids` (or over every paper without an up-to-date summary) would summarize, and its cost. */
  async plan(ids?: string[]): Promise<SummaryPlan> {
    const count = (await this.eligibleIds(ids)).length
    return { count, estimateUsd: count * this.deps.budget.currentEstimate(), batchLimitUsd: this.deps.store.config.llm.budget.per_batch_usd }
  }

  async requestBatch(opts: { model?: LlmModel; ids?: string[] } = {}): Promise<{ batchId: string; count: number }> {
    await this.ensureForm()
    const batchId = randomUUID()
    const ids = await this.eligibleIds(opts.ids)
    for (const paperId of ids) this.deps.enqueue({ type: 'summarize', paperId, batchId, ...(opts.model ? { model: opts.model } : {}) })
    return { batchId, count: ids.length }
  }

  /** Papers whose up-to-date summary lacks facets of the current form (among `ids` when given), none being filled or summarized now. */
  private fillableIds(ids?: string[]): string[] {
    const { cache } = this.deps
    const rows = ids ? ids.flatMap((id) => cache.getPaper(id) ?? []) : cache.listPapers()
    return rows
      .filter(
        (r) =>
          !r.problem &&
          r.unfilled_facets > 0 &&
          UP_TO_DATE.has(r.summary_status) &&
          r.text_status === 'ok' &&
          !cache.hasActiveJob('fill_facets', r.id) &&
          !cache.hasActiveJob('summarize', r.id)
      )
      .map((r) => r.id)
  }

  /** «Llenar facetas nuevas» / «Llenar en N papers»: how many papers and the estimated cost. */
  fillPlan(ids?: string[]): SummaryPlan {
    const count = this.fillableIds(ids).length
    return { count, estimateUsd: count * this.deps.budget.currentEstimate('fill_facets'), batchLimitUsd: this.deps.store.config.llm.budget.per_batch_usd }
  }

  /** One fill_facets job per fillable paper, in one batch (so the batch cap applies). */
  requestFill(ids?: string[]): { batchId: string; count: number } {
    if (loadForm(this.deps.store.config.extraction_form).status !== 'ok') throw new UserFacingError('invalid_form')
    const batchId = randomUUID()
    const fillable = this.fillableIds(ids)
    for (const paperId of fillable) this.deps.enqueue({ type: 'fill_facets', paperId, batchId })
    return { batchId, count: fillable.length }
  }

  async runFill(paperId: string, opts: { batchId?: string; signal?: AbortSignal }): Promise<{ paperId: string; message: 'facets_filled' | 'facets_nothing_to_fill' }> {
    try {
      const { filled } = await this.deps.filler.fill({ paperId, batchId: opts.batchId, signal: opts.signal })
      return { paperId, message: filled.length > 0 ? 'facets_filled' : 'facets_nothing_to_fill' }
    } catch (error) {
      if (opts.signal?.aborted) throw error
      const facing = toUserFacing(error)
      if (opts.batchId && BATCH_STOPPERS.has(facing.code)) this.deps.cancelBatch(opts.batchId)
      throw facing
    } finally {
      if (!opts.signal?.aborted) {
        // A failing reindex must not replace the fill's own outcome.
        await this.deps.reindex(paperId).catch((error: unknown) => console.error('reindex', paperId, error))
        this.deps.emit()
      }
    }
  }

  async autoAfterIngest(paperId: string): Promise<void> {
    if (!this.deps.store.config.llm.auto_summarize) return
    const row = this.deps.cache.getPaper(paperId)
    if (row?.text_status !== 'ok' || !ELIGIBLE.has(row.summary_status)) return
    if (loadForm(this.deps.store.config.extraction_form).status === 'invalid') return
    await this.request(paperId)
  }

  /** Marks a field, facet or the thesis relation verified (or back to generated). Returns an undo token for revert(). */
  async setStatus(paperId: string, section: Section, key: string, status: 'verified' | 'generated'): Promise<string> {
    const files = await this.read(paperId)
    let written: WrittenHashes
    if (section === 'fields') {
      const summary = requireSummary(files)
      written = await this.save(paperId, files, { summary: setFieldStatus(summary, fieldKey(key), status) })
    } else if (section === 'thesis') {
      thesisKey(key)
      const next = setThesisStatus(requireExtraction(files), status)
      written = await this.save(paperId, files, { extraction: status === 'verified' ? this.stampThesis(next) : next })
    } else {
      const extraction = requireExtraction(files)
      const form = await this.ensureForm()
      const def = form.facets.find((f) => f.key === key)
      written = await this.save(paperId, files, { extraction: setFacetStatus(extraction, key, status, def) })
    }
    await this.changed([paperId])
    return this.rememberEdit(paperId, files, written)
  }

  /** Edits a field, facet or the thesis relation (it becomes `edited`). Returns an undo token for revert(). */
  async edit(paperId: string, section: Section, key: string, value: unknown): Promise<string> {
    let files: PaperFiles
    let written: WrittenHashes
    if (section === 'fields') {
      files = await this.read(paperId)
      written = await this.save(paperId, files, { summary: editField(requireSummary(files), fieldKey(key), value) })
    } else if (section === 'thesis') {
      thesisKey(key)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidEdit('Invalid value for the thesis relation')
      files = await this.read(paperId)
      const next = editThesisRelation(requireExtraction(files), this.deps.store.config.thesis, value as ThesisPatch)
      written = await this.save(paperId, files, { extraction: this.stampThesis(next) })
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidEdit(`Invalid value for ${key}`)
      const form = await this.ensureForm()
      files = await this.read(paperId)
      const extraction = requireExtraction(files)
      written = await this.save(paperId, files, { extraction: keepUpToDate(form, extraction, editFacet(extraction, form, key, value as FacetPatch)) })
    }
    await this.changed([paperId])
    return this.rememberEdit(paperId, files, written)
  }

  /** «Verificar todo» of one paper. Returns an undo token for revert(). */
  async verifyAll(paperId: string): Promise<string> {
    const files = await this.read(paperId)
    const form = loadForm(this.deps.store.config.extraction_form)
    const next = verifyAll(files.summary?.value ?? null, files.extraction?.value ?? null, form.status === 'ok' ? form.form.facets : null)
    const extraction = next.extraction?.thesis_relation ? this.stampThesis(next.extraction) : next.extraction
    const written = await this.save(paperId, files, { ...(next.summary ? { summary: next.summary } : {}), ...(extraction ? { extraction } : {}) })
    await this.changed([paperId])
    return this.rememberEdit(paperId, files, written)
  }

  /**
   * Adds `value` to the facet's allowed values and moves it out of `proposed` in every paper that proposed it.
   * Returns an undo token for revert().
   */
  async acceptProposed(facetKey: string, value: string): Promise<string> {
    const form = await this.ensureForm()
    choiceFacet(form, facetKey)
    if (!FACET_KEY_PATTERN.test(value)) throw new InvalidEdit(`Invalid value for ${facetKey}`)
    return this.replaceProposals((e) => acceptProposed(e, facetKey, value), addFacetValue(form, facetKey, value), form)
  }

  /** Replaces the proposal `from` with the allowed value `to` in every paper and remembers the alias. Returns an undo token for revert(). */
  async mapProposed(facetKey: string, from: string, to: string): Promise<string> {
    const form = await this.ensureForm()
    if (!choiceFacet(form, facetKey).values.includes(to)) throw new InvalidEdit(`Invalid value for ${facetKey}`)
    return this.replaceProposals((e) => mapProposed(e, facetKey, from, to), addAlias(form, facetKey, from, to), form)
  }

  /**
   * Saves `next` (validated like updateForm) after rewriting, in every paper, what `rewrite` changes (null: nothing).
   * All or nothing: every paper is read and checked first; if a write fails, or the form is no longer `base` (when
   * given) by the time it would be saved, the papers already rewritten are put back and the form is left as it was.
   * Returns what changed, for undoFormChange.
   */
  async changeForm(
    next: ExtractionForm,
    rewrite: ((e: ExtractionFile) => ExtractionFile | null) | null,
    base?: ExtractionForm
  ): Promise<ExtractionChange[]> {
    const load = loadForm(next)
    if (load.status !== 'ok') throw new UserFacingError('invalid_form')
    if (base) this.assertForm(base)
    const pending: PaperRewrite[] = []
    if (rewrite) {
      for (const id of await this.deps.store.listPaperIds()) {
        const raw = await this.readRaw(id)
        // An unreadable extraction.yaml cannot tell whether the paper proposed the value; it is left alone.
        if (!raw.extraction?.ok) continue
        const after = rewrite(raw.extraction.value)
        if (!after) continue
        if (raw.summary && !raw.summary.ok) throw new UserFacingError('file_problem')
        pending.push({ id, files: { title: raw.title, summary: raw.summary, extraction: raw.extraction }, next: after })
      }
    }
    return this.rewriteAndSaveForm(pending, load.form, base)
  }

  /**
   * Undoes a changeForm: only while the form is exactly `expected` and every rewritten classification is exactly what
   * the change left (InvalidEdit otherwise, before anything is written). All or nothing, like changeForm. Returns the
   * undo's own changes, so it can in turn be undone (undoFormChange(expected, previous, returned)).
   */
  async undoFormChange(previous: ExtractionForm, expected: ExtractionForm, changes: ExtractionChange[]): Promise<ExtractionChange[]> {
    const load = loadForm(previous)
    if (load.status !== 'ok') throw new UserFacingError('invalid_form')
    this.assertForm(expected)
    const pending: PaperRewrite[] = []
    for (const change of changes) {
      if (!this.deps.store.paperExists(change.paperId)) throw new InvalidEdit(`${change.paperId} is gone`)
      const raw = await this.readRaw(change.paperId)
      if (!raw.extraction?.ok || raw.extraction.hash !== change.afterHash) throw new InvalidEdit(`${change.paperId} changed since`)
      if (raw.summary && !raw.summary.ok) throw new UserFacingError('file_problem')
      pending.push({ id: change.paperId, files: { title: raw.title, summary: raw.summary, extraction: raw.extraction }, next: change.before })
    }
    return this.rewriteAndSaveForm(pending, load.form, expected)
  }

  /**
   * «Deshacer» of a review change or a proposed value: once, and only while what it wrote is still there (InvalidEdit
   * otherwise, before anything is written, which spends the token). A transient failure (a file being written, a
   * conflict) keeps the token, so the undo can be tried again.
   */
  async revert(undoToken: string): Promise<void> {
    const undo = this.undo.get(undoToken)
    if (!undo) throw new InvalidEdit('Nothing to undo')
    try {
      if (undo.kind === 'form') {
        await this.undoFormChange(undo.formBefore, undo.formAfter, undo.changes)
      } else {
        const files = await this.read(undo.paperId)
        const changed =
          (undo.after.summary !== null && files.summary?.hash !== undo.after.summary) ||
          (undo.after.extraction !== null && files.extraction?.hash !== undo.after.extraction)
        if (changed) throw new InvalidEdit(`${undo.paperId} changed since`)
        await this.save(undo.paperId, files, undo.before)
        await this.changed([undo.paperId])
      }
    } catch (error) {
      if (error instanceof InvalidEdit) this.undo.delete(undoToken)
      throw error
    }
    this.undo.delete(undoToken)
  }

  private rememberEdit(paperId: string, files: PaperFiles, written: WrittenHashes): string {
    return this.remember({
      kind: 'paper',
      paperId,
      before: {
        ...(written.summary !== null && files.summary ? { summary: files.summary.value } : {}),
        ...(written.extraction !== null && files.extraction ? { extraction: files.extraction.value } : {})
      },
      after: written
    })
  }

  private remember(undo: SummaryUndo): string {
    const token = randomUUID()
    this.undo.set(token, undo)
    while (this.undo.size > MAX_UNDO) this.undo.delete(this.undo.keys().next().value!)
    return token
  }

  /** Fields and facets still `generated`, paper by paper (in `ids` order when given, otherwise in list order). */
  async reviewQueue(ids?: string[]): Promise<ReviewItem[]> {
    const { cache, store } = this.deps
    const rows = ids ? ids.flatMap((id) => cache.getPaper(id) ?? []) : cache.listPapers()
    const form = loadForm(store.config.extraction_form)
    const thesis = currentThesisHash(store)
    const items: ReviewItem[] = []
    for (const row of rows) {
      if (row.pending_review <= 0) continue
      const s = await store.readSummary(row.id)
      const e = await store.readExtraction(row.id)
      const summary = s?.ok ? s.value : null
      const extraction = e?.ok ? e.value : null
      const base = { paperId: row.id, title: row.title }
      if (summary) {
        for (const key of SUMMARY_FIELD_KEYS) if (summary.fields[key].status === 'generated') items.push({ ...base, section: 'fields', key })
      }
      if (extraction) {
        // Facets removed from the form stay in the file but are not shown; so does an entry whose shape no longer
        // fits its facet (it was removed and recreated with a different type).
        const defs = form.status === 'ok' ? form.form.facets : null
        const keys = defs ? defs.map((f) => f.key) : Object.keys(extraction.facets)
        for (const key of keys) {
          const entry = extraction.facets[key]
          if (!entry || entry.status !== 'generated') continue
          const def = defs?.find((f) => f.key === key)
          if (def && !entryFitsFacet(def, entry)) continue
          items.push({ ...base, section: 'facets', key })
        }
        if (extraction.thesis_relation?.status === 'generated' || thesisRelationOutdated(extraction, thesis)) items.push({ ...base, section: 'thesis', key: 'relation' })
      }
    }
    return items
  }

  /** Indexed text of one page (or all of it with `page === null`), for reviewing without the PDF. */
  pageText(paperId: string, page: number | null): string {
    const pages = pagesFromChunks(this.deps.cache.chunksFor(paperId))
    if (page === null) return pages.map((p) => p.text).join('\n\n')
    return pages.find((p) => p.page === page)?.text ?? ''
  }

  formInfo(): FormInfo {
    const load = loadForm(this.deps.store.config.extraction_form)
    return load.status === 'ok' ? { status: 'ok', form: load.form } : load
  }

  /**
   * What saving `next` over the current form would do. A summary goes stale when a facet it has entries for is removed or
   * changes its key, type, description or a scale's min/max; adding a facet, or adding/removing allowed values, stales nothing.
   * `removedValuesInUse` only looks at single/multi facets kept under the same key in both forms.
   */
  async formImpact(next: ExtractionForm): Promise<FormImpact> {
    const { store, cache } = this.deps
    const current = loadForm(store.config.extraction_form)
    if (current.status !== 'ok') return { staleCount: 0, removedValuesInUse: [] }
    // Per paper, like the stale check: only facets a paper has entries for count, so adding a facet stales nothing.
    let staleCount = 0
    for (const row of cache.listPapers()) {
      if (row.summary_status !== 'generated' && row.summary_status !== 'reviewed') continue
      const e = await store.readExtraction(row.id)
      if (!e?.ok) continue
      if (formHashFor(next, Object.keys(e.value.facets)) !== e.value.form_hash) staleCount++
    }

    // One candidate (with its removed values) per kept single/multi facet; checked against each paper's
    // extraction with a single read, instead of re-reading every paper once per facet.
    const candidates: { def: Extract<ExtractionForm['facets'][number], { values: string[] }>; removed: string[] }[] = []
    for (const curFacet of current.form.facets) {
      if (!('values' in curFacet)) continue
      const nextFacet = next.facets.find((f) => f.key === curFacet.key)
      if (!nextFacet || !('values' in nextFacet) || nextFacet.type !== curFacet.type) continue
      const removed = curFacet.values.filter((v) => !nextFacet.values.includes(v))
      if (removed.length) candidates.push({ def: curFacet, removed })
    }

    const counts = new Map<string, Map<string, number>>()
    if (candidates.length) {
      for (const id of await store.listPaperIds()) {
        const e = await store.readExtraction(id)
        if (!e?.ok) continue
        for (const { def, removed } of candidates) {
          const entry = e.value.facets[def.key]
          if (!entry || !entryFitsFacet(def, entry)) continue
          const used = def.type === 'single' ? (entry.value ? [entry.value] : []) : (entry.values ?? [])
          if (!used.length) continue
          const perValue = counts.get(def.key) ?? new Map<string, number>()
          for (const v of removed) if (used.includes(v)) perValue.set(v, (perValue.get(v) ?? 0) + 1)
          counts.set(def.key, perValue)
        }
      }
    }

    const removedValuesInUse: FormImpact['removedValuesInUse'] = []
    for (const { def, removed } of candidates) {
      for (const v of removed) {
        const papers = counts.get(def.key)?.get(v) ?? 0
        if (papers > 0) removedValuesInUse.push({ facet: def.key, value: v, papers })
      }
    }
    return { staleCount, removedValuesInUse }
  }

  /** Validated exactly like loadForm; aliases that no longer refer to an existing facet or allowed value are dropped. */
  async updateForm(next: ExtractionForm): Promise<void> {
    const load = loadForm(next)
    if (load.status !== 'ok') throw new UserFacingError('invalid_form')
    const form = load.form
    const allowed = new Map<string, Set<string>>()
    for (const f of form.facets) if ('values' in f) allowed.set(f.key, new Set(f.values))
    const value_aliases = Object.fromEntries(
      Object.entries(form.value_aliases).flatMap(([facetKey, aliases]) => {
        const values = allowed.get(facetKey)
        if (!values) return []
        const kept = Object.fromEntries(Object.entries(aliases).filter(([, to]) => values.has(to)))
        return Object.keys(kept).length ? [[facetKey, kept]] : []
      })
    )
    await this.deps.store.updateConfig({ extraction_form: { ...form, value_aliases } })
    await this.refreshStates()
  }

  /** Restores the default draft form. */
  resetForm(): Promise<void> {
    return this.updateForm(DEFAULT_EXTRACTION_FORM)
  }

  monthSpent(): Promise<number> {
    return this.deps.ledger.monthTotal()
  }

  /** Estimated cost of one summary. */
  estimate(): number {
    return this.deps.budget.currentEstimate()
  }

  thesis(): ThesisContext {
    return this.deps.store.config.thesis
  }

  /**
   * Saves the thesis context and recomputes every paper's state. Question ids are never renumbered (relations refer to
   * them): they must be unique and of the form RQn.
   */
  async updateThesis(ctx: ThesisContext): Promise<void> {
    const parsed = ThesisContextSchema.safeParse(ctx)
    if (!parsed.success) throw new InvalidEdit('Invalid thesis context')
    const ids = parsed.data.research_questions.map((q) => q.id)
    if (new Set(ids).size !== ids.length) throw new InvalidEdit('Duplicated research question ids')
    // The counter never decreases, so a question id already handed out (and possibly still referenced
    // by a relation) is never reused, even if the question that used it was deleted.
    const maxId = ids.reduce((n, id) => Math.max(n, Number(/^RQ(\d+)$/.exec(id)?.[1] ?? 0)), 0)
    const lastRq = Math.max(this.deps.store.config.thesis.last_rq ?? 0, maxId)
    await this.deps.store.updateConfig({ thesis: { ...parsed.data, last_rq: lastRq } })
    await this.refreshStates()
  }

  async updateLlm(patch: Partial<Omit<LlmConfig, 'budget'>> & { budget?: Partial<LlmConfig['budget']> }): Promise<LlmConfig> {
    const current = this.deps.store.config.llm
    const merged = { ...current, ...patch, budget: { ...current.budget, ...(patch.budget ?? {}) } }
    const parsed = LlmConfigShape.safeParse(merged)
    if (!parsed.success) throw new InvalidEdit('Invalid Claude settings')
    await this.deps.store.updateConfig({ llm: parsed.data })
    await this.refreshStates()
    return this.deps.store.config.llm
  }

  /** The user reviewed the relation against the current thesis: it is no longer stale. */
  private stampThesis(extraction: ExtractionFile): ExtractionFile {
    const thesis = this.deps.store.config.thesis
    return hasThesisContext(thesis) ? { ...extraction, thesis_hash: thesisHash(thesis) } : extraction
  }

  /** Recomputes every paper's summary state after a change of project.yaml (form, thesis or max_input_chars), then notifies once. */
  async refreshStates(): Promise<void> {
    const { store, cache } = this.deps
    for (const id of cache.paperIds()) {
      if (store.paperExists(id)) await indexSummary(store, cache, id).catch((error: unknown) => console.error('summary state', id, error))
    }
    this.deps.emit()
    this.deps.statesRefreshed?.()
  }

  /** InvalidEdit unless the saved form is exactly `form`. */
  private assertForm(form: ExtractionForm): void {
    const current = loadForm(this.deps.store.config.extraction_form)
    const wanted = loadForm(form)
    if (current.status !== 'ok' || wanted.status !== 'ok' || JSON.stringify(sortKeys(current.form)) !== JSON.stringify(sortKeys(wanted.form))) {
      throw new InvalidEdit('The form changed since')
    }
  }

  /**
   * Writes each paper's new classification, then the form. If anything fails (or the form is no longer `base`), the
   * papers already written are put back (hash-checked) before the error is rethrown, and the form is not saved.
   * Every state is refreshed either way.
   */
  private async rewriteAndSaveForm(pending: PaperRewrite[], form: ExtractionForm, base?: ExtractionForm): Promise<ExtractionChange[]> {
    const written: { p: PaperRewrite; hashes: SavedHashes }[] = []
    try {
      for (const p of pending) written.push({ p, hashes: await this.saveOrRestore(p.id, p.files, p.next) })
      if (base) this.assertForm(base)
      await this.deps.store.updateConfig({ extraction_form: form })
    } catch (error) {
      for (const { p, hashes } of written.reverse()) {
        const files: PaperFiles = {
          title: p.files.title,
          summary: p.files.summary && hashes.summary ? { value: p.files.summary.value, hash: hashes.summary } : p.files.summary,
          extraction: { value: p.next, hash: hashes.extraction! }
        }
        await this.save(p.id, files, { extraction: p.files.extraction!.value }).catch((e: unknown) => console.error('could not put back', p.id, e))
      }
      throw error
    } finally {
      await this.refreshStates()
    }
    return written.map(({ p, hashes }) => ({ paperId: p.id, before: p.files.extraction!.value, afterHash: hashes.extraction! }))
  }

  /** save() of a new classification; if summary.md then cannot be written, the classification is put back before rethrowing. */
  private async saveOrRestore(paperId: string, files: PaperFiles, next: ExtractionFile): Promise<SavedHashes> {
    const { store } = this.deps
    const extractionHash = await store.writeExtraction(paperId, next, files.extraction?.hash ?? null)
    const summary = files.summary?.value
    if (!summary) return { extraction: extractionHash, summary: null }
    try {
      const summaryHash = await store.writeSummary(paperId, summary, renderSummaryMarkdown(files.title, summary, next), files.summary!.hash)
      return { extraction: extractionHash, summary: summaryHash }
    } catch (error) {
      if (files.extraction) {
        await store.writeExtraction(paperId, files.extraction.value, extractionHash).catch((e: unknown) => console.error('could not put back', paperId, e))
      }
      throw error
    }
  }

  /**
   * All or nothing up front: every affected paper is read once and checked before anything is written.
   * If a write still fails midway, the form and the index are updated for what was written, so a retry finishes the rest.
   */
  private async replaceProposals(apply: (e: ExtractionFile) => ExtractionFile | null, form: ExtractionForm, base: ExtractionForm): Promise<string> {
    const pending: { id: string; files: PaperFiles; next: ExtractionFile }[] = []
    for (const id of await this.deps.store.listPaperIds()) {
      const raw = await this.readRaw(id)
      // An unreadable extraction.yaml cannot tell whether the paper proposed the value; it is left alone.
      if (!raw.extraction?.ok) continue
      const next = apply(raw.extraction.value)
      if (!next) continue
      if (raw.summary && !raw.summary.ok) throw new UserFacingError('file_problem')
      pending.push({ id, files: { title: raw.title, summary: raw.summary, extraction: raw.extraction }, next })
    }
    const changes: ExtractionChange[] = []
    try {
      for (const p of pending) {
        const written = await this.save(p.id, p.files, { extraction: p.next })
        changes.push({ paperId: p.id, before: p.files.extraction!.value, afterHash: written.extraction! })
      }
    } finally {
      try {
        await this.deps.store.updateConfig({ extraction_form: form })
      } finally {
        await this.refreshStates()
      }
    }
    // Only a change that finished can be undone, and only all at once (undoFormChange).
    return this.remember({ kind: 'form', formBefore: base, formAfter: form, changes })
  }

  private async readRaw(paperId: string) {
    const { store, cache } = this.deps
    const summary = await store.readSummary(paperId)
    const extraction = await store.readExtraction(paperId)
    const paper = await store.readPaper(paperId)
    const title = paper.ok ? paper.value.title : (cache.getPaper(paperId)?.title ?? paperId)
    return { title, summary, extraction }
  }

  private async read(paperId: string): Promise<PaperFiles> {
    if (!this.deps.store.paperExists(paperId)) throw new UserFacingError('file_problem')
    const { title, summary: s, extraction: e } = await this.readRaw(paperId)
    if ((s && !s.ok) || (e && !e.ok)) throw new UserFacingError('file_problem')
    return { title, summary: s?.ok ? s : null, extraction: e?.ok ? e : null }
  }

  /** Writes what changed; summary.md's body is regenerated whenever either file changes, since it shows both. */
  private async save(paperId: string, files: PaperFiles, next: { summary?: SummaryFile; extraction?: ExtractionFile }): Promise<WrittenHashes> {
    const { store } = this.deps
    const extraction = next.extraction ?? files.extraction?.value ?? null
    const extractionHash = next.extraction ? await store.writeExtraction(paperId, next.extraction, files.extraction?.hash ?? null) : null
    const summary = next.summary ?? files.summary?.value
    const summaryHash = summary ? await store.writeSummary(paperId, summary, renderSummaryMarkdown(files.title, summary, extraction), files.summary?.hash ?? null) : null
    return { summary: summaryHash, extraction: extractionHash }
  }

  private async changed(ids: string[]): Promise<void> {
    for (const id of ids) await this.deps.reindex(id)
    this.deps.emit()
  }
}

/**
 * Filling an unfilled facet by hand moves the paper's form hash forward over it, like filling it with Claude, so the
 * paper stays up to date; a stale paper keeps its old hash.
 */
function keepUpToDate(form: ExtractionForm, before: ExtractionFile, after: ExtractionFile): ExtractionFile {
  if (formHashFor(form, Object.keys(before.facets)) !== before.form_hash) return after
  return { ...after, form_hash: formHashFor(form, Object.keys(after.facets)) }
}

function fieldKey(key: string): SummaryFieldKey {
  if (!(SUMMARY_FIELD_KEYS as readonly string[]).includes(key)) throw new InvalidEdit(`Unknown field ${key}`)
  return key as SummaryFieldKey
}

function thesisKey(key: string): void {
  if (key !== 'relation') throw new InvalidEdit(`Unknown thesis key ${key}`)
}

function requireSummary(files: PaperFiles): SummaryFile {
  if (!files.summary) throw new InvalidEdit('The paper has no summary')
  return files.summary.value
}

function requireExtraction(files: PaperFiles): ExtractionFile {
  if (!files.extraction) throw new InvalidEdit('The paper has no classification')
  return files.extraction.value
}

function choiceFacet(form: ExtractionForm, facetKey: string): { values: string[] } {
  const def = form.facets.find((f) => f.key === facetKey)
  if (!def || !('values' in def)) throw new InvalidEdit(`Facet ${facetKey} has no fixed values`)
  return def
}
