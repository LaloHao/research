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
import type { ProjectStore } from '../project/ProjectStore'
import { DEFAULT_EXTRACTION_FORM, formHash, loadForm } from './extractionForm'
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
import type { Summarizer } from './Summarizer'
import { editThesisRelation, hasThesisContext, thesisHash, type ThesisPatch } from './thesis'

const BATCH_STOPPERS = new Set(['llm_quota', 'budget_exceeded'])
const ELIGIBLE = new Set(['none', 'stale', 'failed'])

/** Brings the summary columns of one cache row up to date (status, pending count, searchable text). */
export async function indexSummary(store: ProjectStore, cache: IndexCache, id: string): Promise<void> {
  const s = await store.readSummary(id)
  const e = await store.readExtraction(id)
  const summary = s?.ok ? s.value : null
  const extraction = e?.ok ? e.value : null
  const form = loadForm(store.config.extraction_form)
  const facetDefs = form.status === 'ok' ? form.form.facets : null
  const facetKeys = facetDefs ? facetDefs.map((f) => f.key) : null
  const currentThesis = currentThesisHash(store)
  const status = summaryState({
    facetKeys,
    facetDefs,
    summary,
    extraction,
    formHash: form.status === 'ok' ? form.hash : null,
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
    summary?.generated.model ?? null
  )
}

/** Hash of the project's thesis context; null when there is none. */
export function currentThesisHash(store: ProjectStore): string | null {
  return hasThesisContext(store.config.thesis) ? thesisHash(store.config.thesis) : null
}

export interface SummaryServiceDeps {
  store: ProjectStore
  cache: IndexCache
  summarizer: Summarizer
  budget: BudgetGuard
  ledger: CostLedger
  reindex: (id: string) => Promise<void>
  emit: () => void
  enqueue: (spec: JobSpec) => number
  cancelBatch: (batchId: string) => number
}

/** Both files of a paper as read from disk, with the hashes needed to write them back. */
interface PaperFiles {
  title: string
  summary: { value: SummaryFile; hash: string } | null
  extraction: { value: ExtractionFile; hash: string } | null
}

/** Summaries of one project: jobs, batches, review edits and proposed values. */
export class SummaryService {
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

  async plan(): Promise<SummaryPlan> {
    const count = (await this.eligibleIds()).length
    return { count, estimateUsd: count * this.deps.budget.currentEstimate(), batchLimitUsd: this.deps.store.config.llm.budget.per_batch_usd }
  }

  async requestBatch(opts: { model?: LlmModel; ids?: string[] } = {}): Promise<{ batchId: string; count: number }> {
    await this.ensureForm()
    const batchId = randomUUID()
    const ids = await this.eligibleIds(opts.ids)
    for (const paperId of ids) this.deps.enqueue({ type: 'summarize', paperId, batchId, ...(opts.model ? { model: opts.model } : {}) })
    return { batchId, count: ids.length }
  }

  async autoAfterIngest(paperId: string): Promise<void> {
    if (!this.deps.store.config.llm.auto_summarize) return
    const row = this.deps.cache.getPaper(paperId)
    if (row?.text_status !== 'ok' || !ELIGIBLE.has(row.summary_status)) return
    if (loadForm(this.deps.store.config.extraction_form).status === 'invalid') return
    await this.request(paperId)
  }

  async setStatus(paperId: string, section: Section, key: string, status: 'verified' | 'generated'): Promise<void> {
    const files = await this.read(paperId)
    if (section === 'fields') {
      const summary = requireSummary(files)
      await this.save(paperId, files, { summary: setFieldStatus(summary, fieldKey(key), status) })
    } else if (section === 'thesis') {
      thesisKey(key)
      const next = setThesisStatus(requireExtraction(files), status)
      await this.save(paperId, files, { extraction: status === 'verified' ? this.stampThesis(next) : next })
    } else {
      const extraction = requireExtraction(files)
      await this.save(paperId, files, { extraction: setFacetStatus(extraction, key, status) })
    }
    await this.changed([paperId])
  }

  async edit(paperId: string, section: Section, key: string, value: unknown): Promise<void> {
    if (section === 'fields') {
      const files = await this.read(paperId)
      await this.save(paperId, files, { summary: editField(requireSummary(files), fieldKey(key), value) })
    } else if (section === 'thesis') {
      thesisKey(key)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidEdit('Invalid value for the thesis relation')
      const files = await this.read(paperId)
      const next = editThesisRelation(requireExtraction(files), this.deps.store.config.thesis, value as ThesisPatch)
      await this.save(paperId, files, { extraction: this.stampThesis(next) })
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidEdit(`Invalid value for ${key}`)
      const form = await this.ensureForm()
      const files = await this.read(paperId)
      await this.save(paperId, files, { extraction: editFacet(requireExtraction(files), form, key, value as FacetPatch) })
    }
    await this.changed([paperId])
  }

  async verifyAll(paperId: string): Promise<void> {
    const files = await this.read(paperId)
    const next = verifyAll(files.summary?.value ?? null, files.extraction?.value ?? null)
    const extraction = next.extraction?.thesis_relation ? this.stampThesis(next.extraction) : next.extraction
    await this.save(paperId, files, { ...(next.summary ? { summary: next.summary } : {}), ...(extraction ? { extraction } : {}) })
    await this.changed([paperId])
  }

  /** Adds `value` to the facet's allowed values and moves it out of `proposed` in every paper that proposed it. */
  async acceptProposed(facetKey: string, value: string): Promise<void> {
    const form = await this.ensureForm()
    choiceFacet(form, facetKey)
    if (!FACET_KEY_PATTERN.test(value)) throw new InvalidEdit(`Invalid value for ${facetKey}`)
    await this.replaceProposals((e) => acceptProposed(e, facetKey, value), addFacetValue(form, facetKey, value))
  }

  /** Replaces the proposal `from` with the allowed value `to` in every paper and remembers the alias. */
  async mapProposed(facetKey: string, from: string, to: string): Promise<void> {
    const form = await this.ensureForm()
    if (!choiceFacet(form, facetKey).values.includes(to)) throw new InvalidEdit(`Invalid value for ${facetKey}`)
    await this.replaceProposals((e) => mapProposed(e, facetKey, from, to), addAlias(form, facetKey, from, to))
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
   * What saving `next` over the current form would do. 0 stale summaries when the facet hashes are equal (editing
   * descriptions or adding/removing facets or a scale's min/max changes the hash; adding/removing allowed values does not).
   * `removedValuesInUse` only looks at single/multi facets kept under the same key in both forms.
   */
  async formImpact(next: ExtractionForm): Promise<FormImpact> {
    const { store, cache } = this.deps
    const current = loadForm(store.config.extraction_form)
    if (current.status !== 'ok') return { staleCount: 0, removedValuesInUse: [] }
    const staleCount =
      formHash(next) === current.hash ? 0 : cache.listPapers().filter((r) => r.summary_status === 'generated' || r.summary_status === 'reviewed').length

    const removedValuesInUse: FormImpact['removedValuesInUse'] = []
    for (const curFacet of current.form.facets) {
      if (!('values' in curFacet)) continue
      const nextFacet = next.facets.find((f) => f.key === curFacet.key)
      if (!nextFacet || !('values' in nextFacet) || nextFacet.type !== curFacet.type) continue
      const removed = curFacet.values.filter((v) => !nextFacet.values.includes(v))
      if (!removed.length) continue
      const counts = new Map<string, number>()
      for (const id of await store.listPaperIds()) {
        const e = await store.readExtraction(id)
        if (!e?.ok) continue
        const entry = e.value.facets[curFacet.key]
        if (!entry || !entryFitsFacet(curFacet, entry)) continue
        const used = curFacet.type === 'single' ? (entry.value ? [entry.value] : []) : (entry.values ?? [])
        for (const v of removed) if (used.includes(v)) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      for (const v of removed) {
        const papers = counts.get(v) ?? 0
        if (papers > 0) removedValuesInUse.push({ facet: curFacet.key, value: v, papers })
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
    await this.deps.store.updateConfig({ thesis: parsed.data })
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
  }

  /**
   * All or nothing up front: every affected paper is read once and checked before anything is written.
   * If a write still fails midway, the form and the index are updated for what was written, so a retry finishes the rest.
   */
  private async replaceProposals(apply: (e: ExtractionFile) => ExtractionFile | null, form: ExtractionForm): Promise<void> {
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
    try {
      for (const p of pending) await this.save(p.id, p.files, { extraction: p.next })
    } finally {
      try {
        await this.deps.store.updateConfig({ extraction_form: form })
      } finally {
        await this.refreshStates()
      }
    }
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
  private async save(paperId: string, files: PaperFiles, next: { summary?: SummaryFile; extraction?: ExtractionFile }): Promise<void> {
    const { store } = this.deps
    const extraction = next.extraction ?? files.extraction?.value ?? null
    if (next.extraction) await store.writeExtraction(paperId, next.extraction, files.extraction?.hash ?? null)
    const summary = next.summary ?? files.summary?.value
    if (summary) await store.writeSummary(paperId, summary, renderSummaryMarkdown(files.title, summary, extraction), files.summary?.hash ?? null)
  }

  private async changed(ids: string[]): Promise<void> {
    for (const id of ids) await this.deps.reindex(id)
    this.deps.emit()
  }
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
