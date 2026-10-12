import type { FacetSuggestion } from '../../shared/facetSuggestions'
import type { PaperRow } from '../../shared/library'
import type { LlmModel } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type CompleteResult, type LlmProvider } from '../llm/LlmProvider'
import { UserFacingError } from '../library/UserFacingError'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import type { ProjectStore } from '../project/ProjectStore'
import { AGENT_TIMEOUT_MS } from '../relations/RelationSuggester'
import { loadForm } from '../summary/extractionForm'
import { pagesFromChunks, type PageText } from '../summary/paperText'
import { computeFacetOverview, libraryExtractions } from './facetOverview'
import { checkExamples, parseFacetOutput, toSuggestion, type FacetDropReason } from './facetSuggestionOutput'
import {
  FACET_MAX_TURNS,
  FACET_PROMPT_VERSION,
  facetInput,
  facetJsonSchema,
  facetSystemPrompt,
  MAX_INVENTORY,
  type InventoryPaper
} from './facetSuggestionPrompt'

export interface FacetSuggesterDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  /** Starts the read-only MCP server for one run (closed when the run ends). */
  startTools: (opts: LibraryMcpOptions) => Promise<LibraryMcpHandle>
  now?: () => Date
}

export interface FacetSuggestRequest {
  /** Every suggestion in the file: the rejected ones are shown to the agent and never suggested again. */
  existing: FacetSuggestion[]
  batchId?: string
  model?: LlmModel
  signal?: AbortSignal
}

export interface FacetSuggestResult {
  suggestions: FacetSuggestion[]
  dropped: FacetDropReason[]
  costUsd: number
  model: string
  toolCalls: number
  evidenceFound: number
  evidenceTotal: number
}

const byId = (a: PaperRow, b: PaperRow): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** One agent run over the whole library: form, usage, inventory, budget, MCP tools, validation and quote check. Writes nothing. */
export class FacetSuggester {
  constructor(private readonly deps: FacetSuggesterDeps) {}

  async suggest(req: FacetSuggestRequest): Promise<FacetSuggestResult> {
    const { store, cache, provider, budget, ledger } = this.deps
    const form = loadForm(store.config.extraction_form)
    if (form.status !== 'ok') throw new UserFacingError('invalid_form')
    const rows = cache
      .listPapers()
      .filter((r) => !r.problem)
      .sort(byId)
    const overview = computeFacetOverview(form.form, await libraryExtractions(store, cache))
    const inventory = await this.inventory(rows.slice(0, MAX_INVENTORY))
    const rejected = req.existing.filter((s) => s.status === 'rejected')
    req.signal?.throwIfAborted()

    const llm = store.config.llm
    const reservation = await budget.admit(req.batchId, 'suggest_facets')
    let spent = 0
    let estimated = false
    let model: string = req.model ?? llm.model
    try {
      const tools = await this.deps.startTools({ maxToolCalls: FACET_MAX_TURNS }).catch((error: unknown) => {
        throw new UserFacingError('agent_tools_unavailable', { cause: error })
      })
      let result: CompleteResult
      let toolCalls = 0
      try {
        result = await provider.runAgent({
          system: facetSystemPrompt(store.config.content_language),
          input: facetInput({ thesis: store.config.thesis, form: form.form, inventory, total: rows.length, overview, rejected }),
          schema: facetJsonSchema(),
          model,
          maxUsd: llm.budget.per_facet_suggestion_usd,
          mcp: { name: MCP_SERVER_NAME, url: tools.url, token: tools.token },
          maxTurns: FACET_MAX_TURNS,
          signal: req.signal,
          timeoutMs: AGENT_TIMEOUT_MS
        })
      } catch (error) {
        // A timed-out or cancelled run is charged at its cap (estimated), so the batch and monthly caps count it.
        const charge = failedCallCost(error)
        if (charge.costUsd > 0) {
          spent += charge.costUsd
          estimated = charge.estimated
          await ledger.append({ paperId: '', batchId: req.batchId, model, costUsd: charge.costUsd, operation: 'suggest_facets', estimated: charge.estimated })
        }
        throw error
      } finally {
        toolCalls = tools.calls().filter((c) => c.ok).length
        await tools.close()
      }
      spent += result.costUsd
      model = result.model
      await ledger.append({ paperId: '', batchId: req.batchId, model, costUsd: result.costUsd, operation: 'suggest_facets' })

      const parsed = parseFacetOutput(result.value, {
        form: form.form,
        overview,
        rejected: new Set(rejected.map((s) => s.id)),
        papers: new Set(rows.map((r) => r.id))
      })
      if (!parsed.ok) throw new LlmError('llm_invalid_output', spent)
      const at = (this.deps.now ?? (() => new Date()))().toISOString()
      const origin = { model, at, prompt_version: FACET_PROMPT_VERSION }
      const pages = new Map<string, PageText[]>()
      const pagesOf = (paperId: string): PageText[] => {
        let p = pages.get(paperId)
        if (!p) {
          p = pagesFromChunks(cache.chunksFor(paperId))
          pages.set(paperId, p)
        }
        return p
      }
      let evidenceFound = 0
      let evidenceTotal = 0
      const suggestions = parsed.suggestions.map((p) => {
        const examples = checkExamples(p.examples, pagesOf)
        evidenceTotal += examples.length
        evidenceFound += examples.filter((e) => e.found).length
        return toSuggestion(p, examples, origin, at)
      })
      return { suggestions, dropped: parsed.dropped, costUsd: spent, model, toolCalls, evidenceFound, evidenceTotal }
    } finally {
      reservation.settle(spent, { estimated })
    }
  }

  /** Key, title, year and each paper's tl;dr, or its abstract (facetInput cuts long ones and marks the cut). */
  private async inventory(rows: PaperRow[]): Promise<InventoryPaper[]> {
    const out: InventoryPaper[] = []
    for (const r of rows) out.push({ id: r.id, title: r.title, year: r.year, summary: await this.shortSummary(r.id) })
    return out
  }

  private async shortSummary(id: string): Promise<string | null> {
    const s = await this.deps.store.readSummary(id).catch(() => null)
    if (s?.ok && s.value.fields.tldr.value) return s.value.fields.tldr.value
    const p = await this.deps.store.readPaper(id).catch(() => null)
    return p?.ok && p.value.abstract ? p.value.abstract : null
  }
}
