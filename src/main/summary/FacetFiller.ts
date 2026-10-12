import type { ExtractionFile, ExtractionForm, FacetEntry, LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type CompleteResult, type LlmProvider } from '../llm/LlmProvider'
import { UserFacingError } from '../library/UserFacingError'
import { ConflictError } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { locateQuote } from './evidence'
import { formHashFor, loadForm, unfilledFacets } from './extractionForm'
import { FILL_PROMPT_VERSION, fillJsonSchema, fillSystemPrompt, parseFillOutput, type FillOutput } from './fillPrompt'
import { facetEntry } from './llmOutput'
import { renderSummaryMarkdown } from './markdown'
import { buildPaperText } from './paperText'
import { retryNote, userInput } from './prompt'
import { hasThesisContext } from './thesis'

export interface FacetFillerDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  now?: () => Date
}

export interface FillRequest {
  paperId: string
  batchId?: string
  model?: LlmModel
  signal?: AbortSignal
}

export interface FillResult {
  /** Facet keys written; empty when the paper had nothing to fill. */
  filled: string[]
  costUsd: number
}

/** The paper's classification matches the current definitions of every facet it has entries for. */
const upToDate = (form: ExtractionForm, extraction: ExtractionFile): boolean => formHashFor(form, Object.keys(extraction.facets)) === extraction.form_hash

/**
 * Fills the facets a paper's up-to-date classification lacks (added to the form after it was summarized): one call
 * with only those facets, evidence checked, merged without touching the summary or any existing entry.
 */
export class FacetFiller {
  constructor(private readonly deps: FacetFillerDeps) {}

  async fill(req: FillRequest): Promise<FillResult> {
    const { store, cache, provider, budget, ledger } = this.deps
    const id = req.paperId
    if (!store.paperExists(id)) throw new UserFacingError('file_problem')
    const paper = await store.readPaper(id)
    if (!paper.ok) throw new UserFacingError('file_problem')
    const form = loadForm(store.config.extraction_form)
    if (form.status !== 'ok') throw new UserFacingError('invalid_form')
    const files = await this.files(id)
    if (!files) return { filled: [], costUsd: 0 }
    const extraction = files.extraction.value
    // A stale paper is regenerated, not filled: its whole classification is out of date.
    if (!upToDate(form.form, extraction)) throw new UserFacingError('summary_outdated')
    const missing = unfilledFacets(form.form, extraction)
    if (missing.length === 0) return { filled: [], costUsd: 0 }
    if (cache.getPaper(id)?.text_status !== 'ok') throw new UserFacingError('no_text')
    const llm = store.config.llm
    // The same cut as the summary: a paper summarized from its truncated beginning is filled from it too.
    const truncated = Boolean(files.summary.value.generated.truncated)
    const text = buildPaperText(cache.chunksFor(id), { maxChars: llm.max_input_chars, force: truncated })
    if (text.tooLong && !truncated) throw new UserFacingError('too_long')
    req.signal?.throwIfAborted()
    const thesis = hasThesisContext(store.config.thesis) ? store.config.thesis : null

    const reservation = await budget.admit(req.batchId, 'fill_facets')
    let spent = 0
    let estimated = false
    let model: string = req.model ?? llm.model
    try {
      const base = {
        system: fillSystemPrompt(missing, store.config.content_language, thesis),
        input: userInput(paper.value.title, text.input),
        schema: fillJsonSchema(missing),
        model,
        maxUsd: llm.budget.per_operation_usd,
        signal: req.signal
      }
      let out: FillOutput | null = null
      let lastError = ''
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        const input = attempt === 0 ? base.input : `${base.input}\n\n${retryNote(lastError)}`
        let result: CompleteResult
        try {
          result = await provider.complete({ ...base, input })
        } catch (error) {
          const charge = failedCallCost(error)
          if (charge.costUsd > 0) {
            spent += charge.costUsd
            estimated ||= charge.estimated
            await ledger.append({ paperId: id, batchId: req.batchId, model, costUsd: charge.costUsd, operation: 'fill_facets', estimated: charge.estimated })
          }
          throw error
        }
        spent += result.costUsd
        model = result.model
        await ledger.append({ paperId: id, batchId: req.batchId, model, costUsd: result.costUsd, operation: 'fill_facets' })
        const parsed = parseFillOutput(result.value, missing)
        if (parsed.ok) out = parsed.value
        else lastError = parsed.error
      }
      if (!out) throw new LlmError('llm_invalid_output', spent)
      const origin = { model, at: (this.deps.now ?? (() => new Date()))().toISOString(), prompt_version: FILL_PROMPT_VERSION }
      const entries: Record<string, FacetEntry> = {}
      for (const def of missing) {
        const entry = facetEntry(form.form, def, out.facets[def.key] ?? { evidence: [] }, origin)
        entries[def.key] = {
          ...entry,
          evidence: entry.evidence.map((e) => {
            const r = locateQuote(e.quote, text.pages, e.page)
            return { quote: e.quote, page: r.page, found: r.found }
          })
        }
      }
      // A fill cancelled (or whose paper went to the trash) while Claude answered writes nothing.
      req.signal?.throwIfAborted()
      return { filled: await this.write(id, paper.value.title, form.form, Object.keys(extraction.facets), entries), costUsd: spent }
    } finally {
      reservation.settle(spent, { estimated })
    }
  }

  /** Both files of the paper, readable; null when it has no summary or classification yet (nothing to fill). */
  private async files(id: string) {
    const { store } = this.deps
    const s = await store.readSummary(id)
    const e = await store.readExtraction(id)
    if ((s && !s.ok) || (e && !e.ok)) throw new UserFacingError('file_problem')
    if (!s?.ok || !e?.ok) return null
    return { summary: s, extraction: e }
  }

  /**
   * Adds only the facets still missing on disk (one the user filled by hand meanwhile wins) and moves the paper's
   * form hash forward over them, so the paper stays up to date; summary.md's body is rendered again. Everything is
   * re-checked against the form as it is now: a paper that went stale meanwhile gets nothing, and a facet whose
   * definition changed (or that was removed) while Claude answered is left unfilled. Re-reads once on a concurrent edit.
   * Once the classification is written the fill is done: if summary.md still conflicts on the second try, only its
   * body lags, and the next edit or regeneration of the summary renders it again.
   */
  private async write(id: string, title: string, asked: ExtractionForm, keysBefore: string[], entries: Record<string, FacetEntry>): Promise<string[]> {
    const { store } = this.deps
    let filled: string[] = []
    for (let attempt = 0; ; attempt++) {
      const load = loadForm(store.config.extraction_form)
      if (load.status !== 'ok') throw new UserFacingError('invalid_form')
      const form = load.form
      const files = await this.files(id)
      if (!files) throw new UserFacingError('file_problem')
      const current = files.extraction.value
      // A facet filled by hand meanwhile may or may not have moved the hash forward (older files did not): either is up to date.
      if (!upToDate(form, current) && formHashFor(form, keysBefore) !== current.form_hash) throw new UserFacingError('summary_outdated')
      const added = Object.keys(entries).filter(
        (k) => !current.facets[k] && form.facets.some((f) => f.key === k) && formHashFor(form, [k]) === formHashFor(asked, [k])
      )
      const facets = { ...current.facets, ...Object.fromEntries(added.map((k) => [k, entries[k]])) }
      const next: ExtractionFile = added.length > 0 ? { ...current, facets, form_hash: formHashFor(form, Object.keys(facets)) } : current
      try {
        if (added.length > 0) {
          await store.writeExtraction(id, next, files.extraction.hash)
          filled = [...filled, ...added]
        }
        if (filled.length > 0) await store.writeSummary(id, files.summary.value, renderSummaryMarkdown(title, files.summary.value, next), files.summary.hash)
        return filled
      } catch (error) {
        if (error instanceof ConflictError && attempt === 0) continue
        if (error instanceof ConflictError && filled.length > 0) {
          console.warn(`fill_facets ${id}: summary.md changed on disk, its body is rendered again on the next edit`)
          return filled
        }
        throw error
      }
    }
  }
}
