import type { LlmModel } from '../../shared/summary'
import type { TypedRelation } from '../../shared/typedRelations'
import type { IndexCache } from '../cache/IndexCache'
import type { BudgetGuard } from '../llm/BudgetGuard'
import type { CostLedger } from '../llm/CostLedger'
import { failedCallCost, LlmError, type CompleteResult, type LlmProvider } from '../llm/LlmProvider'
import { UserFacingError } from '../library/UserFacingError'
import { MCP_SERVER_NAME, type LibraryMcpHandle, type LibraryMcpOptions } from '../mcp/LibraryMcpServer'
import type { ProjectStore } from '../project/ProjectStore'
import { pagesFromChunks, type PageText } from '../summary/paperText'
import { candidateIndex, relationCandidates, type CandidateIndex, type RelationCandidate } from './relationCandidates'
import { toEntry } from './relationMerge'
import { checkRelationEvidence, parseRelationOutput, type DropReason } from './relationOutput'
import { MAX_TURNS, RELATION_PROMPT_VERSION, relationInput, relationJsonSchema, relationSystemPrompt, type PromptCandidate } from './relationPrompt'

/** An agent run reads several papers: more room than a single summary call. */
export const AGENT_TIMEOUT_MS = 10 * 60_000
const SHORT_SUMMARY_CHARS = 400

export interface RelationSuggesterDeps {
  store: ProjectStore
  cache: IndexCache
  provider: LlmProvider
  budget: BudgetGuard
  ledger: CostLedger
  /** Starts the read-only MCP server for one run (closed when the run ends). */
  startTools: (opts: LibraryMcpOptions) => Promise<LibraryMcpHandle>
  now?: () => Date
}

export interface SuggestRequest {
  paperId: string
  /** The relations of this paper only (any status); rejected and retyped ids are never suggested again. */
  existing: TypedRelation[]
  /** Candidates to leave out: pairs already analyzed from the other paper (unless the user forced this run). */
  skip?: ReadonlySet<string>
  batchId?: string
  model?: LlmModel
  signal?: AbortSignal
}

export interface SuggestResult {
  relations: TypedRelation[]
  /** The candidates this run analyzed (recorded in relations.yaml as the paper's analysis). */
  candidates: RelationCandidate[]
  costUsd: number
  toolCalls: number
  dropped: DropReason[]
  evidenceFound: number
  evidenceTotal: number
}

/** One agent run for one paper: candidates, prompt, budget, MCP tools, validation and evidence check. Writes nothing. */
export class RelationSuggester {
  constructor(private readonly deps: RelationSuggesterDeps) {}

  /** Build once and pass to candidatesFor when looking at many papers (a batch plan). */
  candidateIndex(): CandidateIndex {
    return candidateIndex(this.deps.cache.relationRows(), this.deps.cache.citationEdges())
  }

  candidatesFor(paperId: string, index: CandidateIndex = this.candidateIndex()): RelationCandidate[] {
    return relationCandidates(paperId, index, this.deps.cache.similarFor(paperId))
  }

  async suggest(req: SuggestRequest): Promise<SuggestResult> {
    const { store, cache, provider, budget, ledger } = this.deps
    const id = req.paperId
    if (!store.paperExists(id)) throw new UserFacingError('file_problem')
    const paper = await store.readPaper(id)
    if (!paper.ok) throw new UserFacingError('file_problem')
    if (cache.getPaper(id)?.text_status !== 'ok') throw new UserFacingError('no_text')
    const candidates = this.candidatesFor(id).filter((c) => !req.skip?.has(c.id))
    if (candidates.length === 0) return { relations: [], candidates, costUsd: 0, toolCalls: 0, dropped: [], evidenceFound: 0, evidenceTotal: 0 }

    const focus = { id, title: paper.value.title, year: paper.value.year ?? null, summary: await this.focusSummary(id, paper.value.abstract ?? null) }
    const promptCandidates: PromptCandidate[] = []
    for (const c of candidates) promptCandidates.push({ id: c.id, title: c.title, year: c.year, summary: await this.shortSummary(c.id), via: c.via })
    req.signal?.throwIfAborted()

    const llm = store.config.llm
    const reservation = await budget.admit(req.batchId, 'suggest_relations')
    let spent = 0
    let estimated = false
    let model: string = req.model ?? llm.model
    try {
      const tools = await this.deps.startTools({ maxToolCalls: MAX_TURNS }).catch((error: unknown) => {
        throw new UserFacingError('agent_tools_unavailable', { cause: error })
      })
      let result: CompleteResult
      let toolCalls = 0
      try {
        result = await provider.runAgent({
          system: relationSystemPrompt(store.config.content_language),
          input: relationInput(focus, promptCandidates, req.existing),
          schema: relationJsonSchema(),
          model,
          maxUsd: llm.budget.per_operation_usd,
          mcp: { name: MCP_SERVER_NAME, url: tools.url, token: tools.token },
          maxTurns: MAX_TURNS,
          signal: req.signal,
          timeoutMs: AGENT_TIMEOUT_MS
        })
      } catch (error) {
        // A timed-out or cancelled run is charged at the per-operation cap (estimated), so batch and monthly caps count it.
        const charge = failedCallCost(error)
        if (charge.costUsd > 0) {
          spent += charge.costUsd
          estimated = charge.estimated
          await ledger.append({ paperId: id, batchId: req.batchId, model, costUsd: charge.costUsd, operation: 'suggest_relations', estimated: charge.estimated })
        }
        throw error
      } finally {
        toolCalls = tools.calls().filter((c) => c.ok).length
        await tools.close()
      }
      spent += result.costUsd
      model = result.model
      await ledger.append({ paperId: id, batchId: req.batchId, model, costUsd: result.costUsd, operation: 'suggest_relations' })

      const parsed = parseRelationOutput(result.value, { paperId: id, candidates: new Set(candidates.map((c) => c.id)), existing: req.existing })
      if (!parsed.ok) throw new LlmError('llm_invalid_output', spent)
      const origin = { model, at: (this.deps.now ?? (() => new Date()))().toISOString(), prompt_version: RELATION_PROMPT_VERSION, paper: id }
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
      const relations = parsed.suggestions.map((s) => {
        const evidence = checkRelationEvidence(s.evidence, pagesOf)
        evidenceTotal += evidence.length
        evidenceFound += evidence.filter((e) => e.found).length
        return toEntry({ ...s, evidence }, origin)
      })
      return { relations, candidates, costUsd: spent, toolCalls, dropped: parsed.dropped, evidenceFound, evidenceTotal }
    } finally {
      reservation.settle(spent, { estimated })
    }
  }

  /** The focus paper's summary (tl;dr, problem, contribution, method), or its abstract. */
  private async focusSummary(id: string, abstract: string | null): Promise<string | null> {
    const s = await this.deps.store.readSummary(id).catch(() => null)
    if (!s?.ok) return abstract
    const f = s.value.fields
    return [f.tldr.value, f.problem.value, f.contribution.value, f.method.value].filter(Boolean).join(' ') || abstract
  }

  /** A candidate's tl;dr, or the beginning of its abstract. */
  private async shortSummary(id: string): Promise<string | null> {
    const s = await this.deps.store.readSummary(id).catch(() => null)
    if (s?.ok && s.value.fields.tldr.value) return s.value.fields.tldr.value
    const p = await this.deps.store.readPaper(id).catch(() => null)
    return p?.ok && p.value.abstract ? p.value.abstract.slice(0, SHORT_SUMMARY_CHARS) : null
  }
}
