import { PAPER_KEY } from '../../shared/chat'
import type { MappingRecord, ProtocolFile } from '../../shared/mapping'
import type { LlmModel } from '../../shared/summary'
import { quoteFound } from '../../shared/textMatch'
import type { IndexCache } from '../cache/IndexCache'
import { UserFacingError } from '../library/UserFacingError'
import { startAgentRun } from '../log/agentLog'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type CompleteResult, type LlmProvider } from '../llm/LlmProvider'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import type { ProjectStore } from '../project/ProjectStore'
import { AGENT_TIMEOUT_MS } from '../relations/RelationSuggester'
import { locateQuote } from '../summary/evidence'
import { pagesFromChunks } from '../summary/paperText'
import { retryNote } from '../summary/prompt'
import {
  FULL_TEXT_MAX_TURNS,
  fullTextInput,
  fullTextSchema,
  fullTextSystemPrompt,
  MAX_RECORDS_PER_CALL,
  parseFullText,
  parseTitleAbstract,
  titleAbstractInput,
  titleAbstractSchema,
  titleAbstractSystemPrompt,
  type ParsedSuggestion
} from './screeningPrompt'

/** Shorter quotes (a word or two) match almost any abstract, so they are never marked as verified. */
const MIN_QUOTE_WORDS = 3
const MIN_QUOTE_CHARS = 15

/** The quote is long enough to mean something and is found in the text. */
export function quoteVerified(quote: string | null, text: string): boolean {
  if (!quote) return false
  const q = quote.trim()
  return q.length >= MIN_QUOTE_CHARS && q.split(/\s+/).length >= MIN_QUOTE_WORDS && quoteFound(q, text)
}

export interface ScreeningSuggesterDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  /** Starts the read-only library MCP server for one full-text run (closed when the run ends). */
  startTools: (opts: LibraryMcpOptions) => Promise<LibraryMcpHandle>
}

export interface SuggestedScreening extends ParsedSuggestion {
  /** The quote was found in the record's title and abstract, or in the paper's pages. */
  found: boolean
}

interface Common {
  protocol: ProtocolFile
  batchId?: string
  model?: LlmModel
  signal?: AbortSignal
}

/** Claude's screening suggestions: the calls, their budget and costs, and the quote checks. Writes nothing. */
export class ScreeningSuggester {
  constructor(private readonly deps: ScreeningSuggesterDeps) {}

  /** One structured call, no tools, for up to MAX_RECORDS_PER_CALL records. */
  async titleAbstract(req: Common & { records: MappingRecord[] }): Promise<{ suggestions: SuggestedScreening[]; dropped: number; costUsd: number; model: string }> {
    const { store, provider, budget, ledger } = this.deps
    if (req.records.length === 0 || req.records.length > MAX_RECORDS_PER_CALL) throw new Error(`Screening calls take 1–${MAX_RECORDS_PER_CALL} records`)
    if (new Set(req.records.map((r) => r.id)).size !== req.records.length) throw new Error('Screening calls take each record once: a record id is repeated')
    const llm = store.config.llm
    const reservation = await budget.admit(req.batchId, 'screening')
    let spent = 0
    let estimated = false
    let model: string = req.model ?? llm.model
    const log = startAgentRun({
      kind: 'screening',
      subject: req.records.length === 1 ? req.records[0]!.id : `${req.records.length} records`,
      model,
      capUsd: llm.budget.per_operation_usd,
      ids: { stage: 'title_abstract', batch: req.batchId }
    })
    try {
      const base = {
        system: titleAbstractSystemPrompt(store.config.content_language),
        input: titleAbstractInput(req.protocol, req.records),
        schema: titleAbstractSchema(),
        model,
        maxUsd: llm.budget.per_operation_usd,
        signal: req.signal
      }
      let parsed: { suggestions: ParsedSuggestion[]; dropped: number } | null = null
      let lastError = ''
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const input = attempt === 0 ? base.input : `${base.input}\n\n${retryNote(lastError)}`
        let result: CompleteResult
        try {
          result = await provider.complete({ ...base, input })
        } catch (error) {
          const charge = failedCallCost(error)
          if (charge.costUsd > 0) {
            spent += charge.costUsd
            estimated ||= charge.estimated
            await ledger.append({ paperId: '', batchId: req.batchId, model, costUsd: charge.costUsd, operation: 'screening', estimated: charge.estimated })
          }
          throw error
        }
        spent += result.costUsd
        model = result.model
        await ledger.append({ paperId: '', batchId: req.batchId, model, costUsd: result.costUsd, operation: 'screening' })
        const out = parseTitleAbstract(result.value, { protocol: req.protocol, records: req.records.map((r) => r.id) })
        if (out.ok) parsed = out
        else lastError = out.error
      }
      if (!parsed) throw new LlmError('llm_invalid_output', spent)
      const byId = new Map(req.records.map((r) => [r.id, r]))
      const suggestions = parsed.suggestions.map((s) => {
        const r = byId.get(s.record)!
        return { ...s, found: quoteVerified(s.quote, `${r.title}\n${r.abstract ?? ''}`) }
      })
      log.end({ costUsd: spent, extra: { suggestions: suggestions.length, dropped: parsed.dropped } })
      return { suggestions, dropped: parsed.dropped, costUsd: spent, model }
    } catch (error) {
      log.fail(error, { costUsd: spent, estimated })
      throw error
    } finally {
      reservation.settle(spent, { estimated })
    }
  }

  /** One agent run with the read-only library tools over the record's library paper. */
  async fullText(req: Common & { record: MappingRecord; paperId: string }): Promise<{ suggestion: SuggestedScreening; costUsd: number; model: string }> {
    const { store, cache, provider, budget, ledger } = this.deps
    if (!PAPER_KEY.test(req.paperId) || !store.paperExists(req.paperId)) throw new UserFacingError('file_problem')
    if (req.record.paper_id !== req.paperId) throw new UserFacingError('not_eligible')
    if (cache.getPaper(req.paperId)?.text_status !== 'ok') throw new UserFacingError('no_text')
    const llm = store.config.llm
    const reservation = await budget.admit(req.batchId, 'screening')
    let spent = 0
    let estimated = false
    let model: string = req.model ?? llm.model
    const log = startAgentRun({
      kind: 'screening',
      subject: req.record.id,
      model,
      capUsd: llm.budget.per_operation_usd,
      maxTurns: FULL_TEXT_MAX_TURNS,
      ids: { stage: 'full_text', paper: req.paperId, batch: req.batchId }
    })
    try {
      const tools = await this.deps.startTools({ maxToolCalls: FULL_TEXT_MAX_TURNS, log }).catch((error: unknown) => {
        throw new UserFacingError('agent_tools_unavailable', { cause: error })
      })
      let result: CompleteResult
      try {
        result = await provider.runAgent({
          system: fullTextSystemPrompt(store.config.content_language),
          input: fullTextInput(req.protocol, req.record, req.paperId),
          schema: fullTextSchema(),
          model,
          maxUsd: llm.budget.per_operation_usd,
          mcp: { name: MCP_SERVER_NAME, url: tools.url, token: tools.token },
          maxTurns: FULL_TEXT_MAX_TURNS,
          signal: req.signal,
          timeoutMs: AGENT_TIMEOUT_MS
        })
      } catch (error) {
        // A timed-out or cancelled run is charged at its cap (estimated), so the batch and monthly caps count it.
        const charge = failedCallCost(error)
        if (charge.costUsd > 0) {
          spent += charge.costUsd
          estimated = charge.estimated
          await ledger.append({ paperId: req.paperId, batchId: req.batchId, model, costUsd: charge.costUsd, operation: 'screening', estimated: charge.estimated })
        }
        throw error
      } finally {
        // A paid run is charged even when the server does not close cleanly.
        await tools.close().catch((error: unknown) => console.warn(`screening ${req.paperId}: closing the library tools failed`, error))
      }
      spent += result.costUsd
      model = result.model
      await ledger.append({ paperId: req.paperId, batchId: req.batchId, model, costUsd: result.costUsd, operation: 'screening' })
      const parsed = parseFullText(result.value, { protocol: req.protocol })
      if (!parsed.ok) throw new LlmError('llm_invalid_output', spent)
      const s = parsed.suggestion
      const located = s.quote ? locateQuote(s.quote, pagesFromChunks(cache.chunksFor(req.paperId)), s.page) : { page: s.page, found: false }
      log.end({ costUsd: spent, turns: result.turns, extra: { decision: s.decision } })
      return { suggestion: { ...s, record: req.record.id, page: located.page, found: located.found }, costUsd: spent, model }
    } catch (error) {
      log.fail(error, { costUsd: spent, estimated })
      throw error
    } finally {
      reservation.settle(spent, { estimated })
    }
  }
}
