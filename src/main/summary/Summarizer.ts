import type { ExtractionFile, LlmModel, SummaryFile } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { LlmError, type LlmProvider } from '../llm/LlmProvider'
import { UserFacingError } from '../library/UserFacingError'
import { ConflictError } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import { checkEvidence } from './evidence'
import { loadForm } from './extractionForm'
import { outputJsonSchema, parseLlmOutput, toGeneratedFiles, type LlmOutput } from './llmOutput'
import { renderSummaryMarkdown } from './markdown'
import { mergeExtraction, mergeSummary } from './merge'
import { buildPaperText } from './paperText'
import { PROMPT_VERSION, retryNote, systemPrompt, userInput } from './prompt'

export interface SummarizerDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  now?: () => Date
}

export interface SummarizeRequest {
  paperId: string
  force?: boolean
  batchId?: string
  model?: LlmModel
  signal?: AbortSignal
}

export interface SummarizeResult {
  costUsd: number
  evidenceFound: number
  evidenceTotal: number
}

const round = (n: number): number => Math.round(n * 10000) / 10000

/** One summary end to end: checks, budget, Claude (one retry), evidence, merge, write. */
export class Summarizer {
  constructor(private readonly deps: SummarizerDeps) {}

  async summarize(req: SummarizeRequest): Promise<SummarizeResult> {
    const { store, cache, provider, budget, ledger } = this.deps
    const id = req.paperId
    if (!store.paperExists(id)) throw new UserFacingError('file_problem')
    const paper = await store.readPaper(id)
    if (!paper.ok) throw new UserFacingError('file_problem')
    const form = loadForm(store.config.extraction_form)
    if (form.status !== 'ok') throw new UserFacingError('invalid_form')
    if (cache.getPaper(id)?.text_status !== 'ok') throw new UserFacingError('no_text')
    const llm = store.config.llm
    const text = buildPaperText(cache.chunksFor(id), { maxChars: llm.max_input_chars, force: req.force })
    if (text.tooLong && !req.force) throw new UserFacingError('too_long')
    await this.assertFilesReadable(id)
    req.signal?.throwIfAborted()

    const reservation = await budget.admit(req.batchId)
    let spent = 0
    let model: string = req.model ?? llm.model
    try {
      const base = {
        system: systemPrompt(form.form, store.config.content_language),
        input: userInput(paper.value.title, text.input),
        schema: outputJsonSchema(form.form),
        model: req.model ?? llm.model,
        maxUsd: llm.budget.per_operation_usd,
        signal: req.signal
      }
      let out: LlmOutput | null = null
      let lastError = ''
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        const input = attempt === 0 ? base.input : `${base.input}\n\n${retryNote(lastError)}`
        let result
        try {
          result = await provider.complete({ ...base, input })
        } catch (error) {
          if (error instanceof LlmError && error.costUsd > 0) {
            spent += error.costUsd
            await ledger.append({ paperId: id, batchId: req.batchId, model, costUsd: error.costUsd })
          }
          throw error
        }
        spent += result.costUsd
        model = result.model
        await ledger.append({ paperId: id, batchId: req.batchId, model: result.model, costUsd: result.costUsd })
        const parsed = parseLlmOutput(result.value, form.form)
        if (parsed.ok) out = parsed.value
        else lastError = parsed.error
      }
      if (!out) throw new LlmError('llm_invalid_output', spent)
      const meta = { model, at: (this.deps.now ?? (() => new Date()))().toISOString(), cost_usd_est: round(spent), prompt_version: PROMPT_VERSION, language: store.config.content_language }
      const generated = toGeneratedFiles(out, form.form, form.hash, meta)
      const checked = checkEvidence(generated.summary, generated.extraction, text.pages)
      await this.write(id, paper.value.title, checked.summary, checked.extraction)
      return { costUsd: spent, evidenceFound: checked.found, evidenceTotal: checked.total }
    } finally {
      reservation.settle(spent)
    }
  }

  /** Throws before anything is spent if either file exists but cannot be read. */
  private async assertFilesReadable(id: string): Promise<void> {
    const { store } = this.deps
    const curS = await store.readSummary(id)
    const curE = await store.readExtraction(id)
    if ((curS && !curS.ok) || (curE && !curE.ok)) throw new UserFacingError('file_problem')
  }

  /** Merges with what is on disk (never touching verified/edited) and writes; re-reads once on a concurrent edit. */
  private async write(id: string, title: string, summary: SummaryFile, extraction: ExtractionFile): Promise<void> {
    const { store } = this.deps
    for (let attempt = 0; ; attempt++) {
      const curS = await store.readSummary(id)
      const curE = await store.readExtraction(id)
      // Re-checked here too: a file edited to something unreadable between the pre-flight check and this write must still block.
      if ((curS && !curS.ok) || (curE && !curE.ok)) throw new UserFacingError('file_problem')
      const s = mergeSummary(curS?.ok ? curS.value : null, summary)
      const e = mergeExtraction(curE?.ok ? curE.value : null, extraction)
      try {
        await store.writeSummary(id, s, renderSummaryMarkdown(title, s, e), curS?.hash ?? null)
        await store.writeExtraction(id, e, curE?.hash ?? null)
        return
      } catch (error) {
        if (error instanceof ConflictError && attempt === 0) continue
        throw error
      }
    }
  }
}
