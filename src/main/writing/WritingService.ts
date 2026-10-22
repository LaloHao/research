import { PAPER_KEY, type PaperState } from '../../shared/chat'
import { SUMMARY_TEXT_FIELDS, thesisLanguage, type Evidence } from '../../shared/summary'
import type { CiteCheckPlan, CiteCheckProgress, CiteCheckRequest, CiteCheckResult } from '../../shared/writing/citeCheck'
import type { ChapterBib, OutlineData, OutlineScope, WritingLibrary, WritingPlanKind, WritingRunPlan } from '../../shared/writing/api'
import { chapterBibReport, type BibLibraryPaper } from '../../shared/writing/bibtex'
import { citedKeys, parseCitations, type CiteFormat } from '../../shared/writing/citations'
import { buildOutline, type Outline, type OutlinePaper } from '../../shared/writing/outline'
import {
  MAX_PROPOSAL_PAPERS,
  outlineProposalSchema,
  outlineTargets,
  parseOutlineProposal,
  proposalTexts,
  type OutlineProposalRun,
  type OutlineRequest
} from '../../shared/writing/outlineProposal'
import { MAX_STYLE_CHARS, parseStyleOutput, STYLE_FOCUSES, styleSchema, validateStyleSuggestions, type StyleFocus, type StyleRequest, type StyleReviewRun } from '../../shared/writing/style'
import type { IndexCache } from '../cache/IndexCache'
import { verifyCitations } from '../chats/citations'
import { rekeyBibtex } from '../ingest/bibtex'
import { UserFacingError } from '../library/UserFacingError'
import type { BudgetGuard } from '../llm/BudgetGuard'
import { limitsFromConfig, operationCap } from '../llm/BudgetGuard'
import { operationPlan, runCappedOperation, type CappedDeps } from '../llm/cappedOperation'
import type { CostLedger } from '../llm/CostLedger'
import type { LlmProvider } from '../llm/LlmProvider'
import { startAgentRun, type AgentKind } from '../log/agentLog'
import type { ProjectStore } from '../project/ProjectStore'
import { loadForm } from '../summary/extractionForm'
import { pagesFromChunks, type PageText } from '../summary/paperText'
import type { CiteChecker } from './CiteChecker'
import { readWithIncludes } from './includes'
import { outlineInput, outlineSystemPrompt, type OutlinePaperData } from './outlinePrompt'
import { completeChecked } from './structuredCall'
import { styleInput, styleSystemPrompt } from './stylePrompt'

export interface WritingDeps {
  store: ProjectStore
  cache: IndexCache
  /** A mapping's papers included on full text («los incluidos de un mapeo»). */
  includedPapers: (mappingId: string) => string[]
  /** Claude, for the operations that use it (absent: they refuse with llm_unavailable). */
  llm?: { provider: LlmProvider; budget: BudgetGuard; ledger: CostLedger }
  /** «Verificar con Claude»; absent where no Claude is wired (tests of the reads). */
  checker?: CiteChecker
}

/** The evidence fields whose quotes the outline proposal sends, in order (the one-liner's first). */
const QUOTE_FIELDS = ['tldr', 'contribution', 'results', ...SUMMARY_TEXT_FIELDS] as const

/**
 * The writing view's reads (which keys the library knows, the chapter .bib, the outline's data) and its Claude
 * operations (citation check, outline proposal, style review). Nothing here writes to the project (drafts, when they
 * come, go through ProjectStore like every other write).
 *
 * Each Claude operation is confirmed and capped the way the chat and the suggesters are: `plan(kind)` answers
 * `operationPlan` (estimate, that kind's cap, the month) plus the default model (the citation check has its own
 * text-dependent plan of the same shape), the renderer asks, the run IPC checks `ipcArgs.confirmed` and the call goes
 * through `runCappedOperation` (../llm/cappedOperation.ts), which admits, caps, logs the cost and settles.
 */
export class WritingService {
  /** The window's running citation check: one at a time, stopped by «Detener» or when the project closes. */
  private check: { controller: AbortController; progress: CiteCheckProgress | null } | null = null
  /** Every Claude run in progress, the window's and the local API's: stopped and awaited when the project closes. */
  private readonly running = new Set<{ controller: AbortController; done: Promise<unknown> }>()
  private closed = false

  constructor(private readonly deps: WritingDeps) {}

  private checker(): CiteChecker {
    if (!this.deps.checker || this.closed) throw new UserFacingError('llm_unavailable')
    return this.deps.checker
  }

  /** What «Verificar con Claude» would check and cost, for the confirmation. */
  citeCheckPlan(text: string, format: CiteFormat): Promise<CiteCheckPlan> {
    return this.checker().plan(text, format)
  }

  /**
   * One citation check of `text`, for any caller (the window, or a local API): the structured result, never written
   * anywhere. The caller has confirmed the cost; `signal` stops it (the result then says `stopped`).
   */
  async citeCheck(req: CiteCheckRequest, opts: { signal?: AbortSignal; onProgress?: (p: CiteCheckProgress) => void } = {}): Promise<CiteCheckResult> {
    const checker = this.checker()
    return this.tracked(opts.signal, (signal) => checker.run({ ...req, onProgress: opts.onProgress, signal }))
  }

  /** The window's check: a new one stops the previous one; its progress is polled with `checkProgress`. */
  async windowCheck(req: CiteCheckRequest): Promise<CiteCheckResult> {
    this.check?.controller.abort()
    const controller = new AbortController()
    const entry: NonNullable<WritingService['check']> = { controller, progress: null }
    this.check = entry
    try {
      return await this.citeCheck(req, { signal: controller.signal, onProgress: (p) => (entry.progress = p) })
    } finally {
      if (this.check === entry) this.check = null
    }
  }

  checkProgress(): CiteCheckProgress | null {
    return this.check?.progress ?? null
  }

  /** «Detener»: the batches answered so far are kept. */
  stopCheck(): void {
    this.check?.controller.abort()
  }

  /** The project closes: no new run starts, and every run in progress (the window's or the API's) stops and is awaited. */
  async close(): Promise<void> {
    this.closed = true
    const runs = [...this.running]
    for (const run of runs) run.controller.abort()
    await Promise.allSettled(runs.map((r) => r.done))
  }

  /** How many Claude runs are in progress (tests, and the close that waits for them). */
  get runningCount(): number {
    return this.running.size
  }

  /**
   * Runs `work` with its own signal, aborted by the caller's `signal` or by `close()`, and kept in `running` until it
   * ends: a run started by the local API has no window to stop it, but the project's close still does.
   */
  private async tracked<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new UserFacingError('llm_unavailable')
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', stop, { once: true })
    const run = work(controller.signal)
    const entry = { controller, done: run.catch(() => undefined) }
    this.running.add(entry)
    try {
      return await run
    } finally {
      this.running.delete(entry)
      signal?.removeEventListener('abort', stop)
    }
  }

  library(): WritingLibrary {
    const { cache } = this.deps
    return {
      papers: cache
        .listPapers()
        .filter((r) => !r.problem)
        .map((r) => ({ id: r.id, title: r.title, year: r.year, hasText: r.text_status === 'ok' })),
      trashed: cache.trashEntries().map((t) => ({ id: t.id, title: t.title }))
    }
  }

  /** «BibTeX» of pasted text. */
  async bibFromText(text: string, format: CiteFormat): Promise<ChapterBib> {
    const citations = parseCitations(text, format)
    return { report: await this.report(citedKeys(citations)), files: [], skipped: [], citations: citations.length }
  }

  /** «BibTeX» of a chosen file and what it includes inside its folder. */
  async bibFromFile(path: string): Promise<ChapterBib> {
    const read = await readWithIncludes(path)
    return { report: await this.report(read.keys), files: read.files, skipped: read.skipped, citations: read.citations }
  }

  /** The cited entries as the library exports them (rekeyed), plus every paper's title for suggestions. */
  private async report(keys: string[]): Promise<ChapterBib['report']> {
    const { store, cache } = this.deps
    const library = new Map<string, BibLibraryPaper>()
    for (const row of cache.listPapers()) if (!row.problem) library.set(row.id, { title: row.title, bibtex: null })
    for (const key of keys) {
      const paper = library.get(key)
      if (!paper || !PAPER_KEY.test(key)) continue
      try {
        const read = await store.readPaper(key)
        if (read.ok) paper.bibtex = rekeyBibtex(read.value.bibtex, key)
      } catch {
        // An invalid entry is left out, as in exports/library.bib; the report lists it.
      }
    }
    return chapterBibReport({ keys, library, trashed: cache.trashedIds() })
  }

  /** «Esquema»: the form's facets, each paper's facet values and one-liner, and the confirmed relations among them. */
  async outlineData(scope: OutlineScope): Promise<OutlineData> {
    const { store, cache } = this.deps
    const form = loadForm(store.config.extraction_form)
    const facets =
      form.status === 'ok' ? form.form.facets.flatMap((f) => (f.type === 'single' || f.type === 'multi' ? [{ key: f.key, values: [...f.values] }] : [])) : []
    const rows = cache.listPapers().filter((r) => !r.problem)
    const wanted = scope.kind === 'library' ? null : new Set(scope.kind === 'papers' ? scope.ids : this.deps.includedPapers(scope.mappingId))
    const papers = new Map<string, OutlinePaper>()
    for (const r of rows) if (!wanted || wanted.has(r.id)) papers.set(r.id, { id: r.id, title: r.title, year: r.year, tldr: null, facets: {} })
    for (const f of cache.facetRows()) {
      const p = papers.get(f.paperId)
      if (!p) continue
      const entry = (p.facets[f.facet] ??= { values: [], reviewed: f.reviewed })
      entry.values.push(f.value)
    }
    for (const p of papers.values()) {
      const read = await store.readSummary(p.id).catch(() => null)
      const tldr = read?.ok ? read.value.fields.tldr.value.trim() : ''
      p.tldr = tldr || null
    }
    const relations = cache
      .typedRelations()
      .filter((r) => r.status === 'confirmed' && papers.has(r.from) && papers.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, type: r.type }))
    return { facets, papers: [...papers.values()], relations }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Claude: «Proponer redacción del esquema» and «Estilo». One confirmed, capped structured call each (no tools); the
  // IPC checks the confirmation, these check what Claude returned. Nothing is written to the project.

  private capped(): CappedDeps & { provider: LlmProvider } {
    const llm = this.deps.llm
    if (!llm || this.closed) throw new UserFacingError('llm_unavailable')
    return { ...llm, limits: () => limitsFromConfig(this.deps.store.config.llm) }
  }

  /** What one operation of `kind` would cost, for the confirmation, and the model it runs on by default. */
  async plan(kind: WritingPlanKind): Promise<WritingRunPlan> {
    return { ...(await operationPlan(this.capped(), kind)), model: this.deps.store.config.llm.model }
  }

  /** The outline «Esquema» shows for these choices, built again from the library. */
  async outlineFor(req: Omit<OutlineRequest, 'model'>): Promise<Outline> {
    const data = await this.outlineData(req.scope)
    const facet = data.facets.find((f) => f.key === req.facet)
    if (!facet) throw new Error(`Unknown facet: ${req.facet}`)
    const secondary = req.secondary ? (data.facets.find((f) => f.key === req.secondary) ?? null) : null
    const question = req.questionId ? (this.deps.store.config.thesis.research_questions.find((q) => q.id === req.questionId) ?? null) : null
    return buildOutline({ papers: data.papers, facet, secondary, relations: data.relations, onlyReviewed: req.onlyReviewed, question })
  }

  /**
   * «Proponer redacción del esquema»: headings, order, openings and gap sentences for the outline, every marker checked
   * against the cited paper's indexed text or its summary's evidence quotes.
   */
  async proposeOutline(req: OutlineRequest, signal?: AbortSignal): Promise<OutlineProposalRun> {
    const deps = this.capped()
    return this.tracked(signal, (stop) => this.proposeOutlineNow(req, deps, stop))
  }

  private async proposeOutlineNow(req: OutlineRequest, deps: CappedDeps & { provider: LlmProvider }, signal: AbortSignal): Promise<OutlineProposalRun> {
    const { store, cache } = this.deps
    const outline = await this.outlineFor(req)
    const targets = outlineTargets(outline)
    if (targets.papers.size === 0) throw new Error('The outline has no papers')
    if (targets.papers.size > MAX_PROPOSAL_PAPERS) throw new UserFacingError('outline_too_large')
    const papers = new Map<string, OutlinePaperData & { evidence: PageText[] }>()
    for (const id of targets.papers) {
      const read = await store.readSummary(id).catch(() => null)
      const fields = read?.ok ? read.value.fields : null
      const quotes: Evidence[] = []
      for (const key of new Set(QUOTE_FIELDS)) for (const e of fields?.[key].evidence ?? []) if (!quotes.some((q) => q.quote === e.quote)) quotes.push(e)
      const tldr = fields?.tldr.value.trim() || null
      papers.set(id, { tldr, quotes, evidence: quotes.map((q) => ({ page: q.page, text: q.quote })) })
    }
    const model = req.model ?? store.config.llm.model
    const run = await this.logged('outline', `${targets.papers.size} papers`, model, deps, () =>
      runCappedOperation(deps, { kind: 'outline', model }, (maxUsd) =>
        completeChecked(
          deps.provider,
          {
            system: outlineSystemPrompt(thesisLanguage(store.config.thesis)),
            input: outlineInput(store.config.thesis, outline, targets, papers),
            schema: outlineProposalSchema(),
            model,
            signal
          },
          maxUsd,
          (raw) => {
            const parsed = parseOutlineProposal(raw, targets)
            return parsed.ok ? { ok: true, value: parsed.proposal } : parsed
          }
        )
      )
    )
    const sources = {
      paperState: (id: string): PaperState => (cache.getPaper(id) ? 'library' : cache.isTrashed(id) ? 'trash' : 'missing'),
      pages: (id: string): PageText[] => [...pagesFromChunks(cache.chunksFor(id)), ...(papers.get(id)?.evidence ?? [])]
    }
    const checks = Object.fromEntries(proposalTexts(run.value).map(({ id, text }) => [id, verifyCitations(text, sources)]))
    return { outline, proposal: run.value, checks, costUsd: run.costUsd, model: run.model }
  }

  /** «Estilo»: Claude's suggestions for the text, each checked (verbatim, protected constructs, overlaps). */
  async reviewStyle(req: StyleRequest, signal?: AbortSignal): Promise<StyleReviewRun> {
    const deps = this.capped()
    if (!req.text.trim()) throw new Error('Nothing to review')
    if (req.text.length > MAX_STYLE_CHARS) throw new UserFacingError('too_long')
    const focus = STYLE_FOCUSES.filter((f) => req.focus.includes(f))
    if (focus.length === 0) throw new Error('No focus chosen')
    return this.tracked(signal, (stop) => this.reviewStyleNow(req, focus, deps, stop))
  }

  private async reviewStyleNow(req: StyleRequest, focus: StyleFocus[], deps: CappedDeps & { provider: LlmProvider }, signal: AbortSignal): Promise<StyleReviewRun> {
    const { store } = this.deps
    const model = req.model ?? store.config.llm.model
    const run = await this.logged('style', `${req.text.length} chars`, model, deps, () =>
      runCappedOperation(deps, { kind: 'style', model }, (maxUsd) =>
        completeChecked(
          deps.provider,
          { system: styleSystemPrompt(focus, req.format, thesisLanguage(store.config.thesis)), input: styleInput(req.text), schema: styleSchema(), model, signal },
          maxUsd,
          (raw) => {
            const parsed = parseStyleOutput(raw)
            if (!parsed.ok) return parsed
            // Only the categories asked for count.
            return { ok: true, value: parsed.suggestions.filter((s) => focus.includes(s.category)) }
          }
        )
      )
    )
    return { ...validateStyleSuggestions(req.text, req.format, run.value), costUsd: run.costUsd, model: run.model }
  }

  /** The run in the app log (never the text, only sizes and costs). */
  private async logged<T extends { costUsd: number }>(kind: AgentKind & ('outline' | 'style'), subject: string, model: string, deps: CappedDeps, work: () => Promise<T>): Promise<T> {
    const log = startAgentRun({ kind, subject, model, capUsd: operationCap(deps.limits(), kind) })
    try {
      const result = await work()
      log.end({ costUsd: result.costUsd })
      return result
    } catch (error) {
      log.fail(error, { costUsd: (error as { costUsd?: number }).costUsd ?? 0, estimated: (error as { estimated?: boolean }).estimated })
      throw error
    }
  }
}
