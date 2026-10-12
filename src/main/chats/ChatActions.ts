import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TOOL_RISK, type ActionCost, type ActionPreview, type ActionReadTool, type ActionTool } from '../../shared/chatActions'
import type { JobRecord } from '../../shared/jobs'
import { USER_ERROR_CODES, type UserErrorCode } from '../../shared/library'
import { FACET_KEY_PATTERN, SUMMARY_FIELD_KEYS, type CostOperation, type SummaryFieldKey } from '../../shared/summary'
import type { DeletePlan, RestoreOutcome, TrashEntry, TrashOutcome, TrashTarget } from '../../shared/trash'
import type { RelationView } from '../../shared/typedRelations'
import type { IndexCache } from '../cache/IndexCache'
import { computeFacetOverview, libraryExtractions } from '../facets/facetOverview'
import type { FacetSuggestionService } from '../facets/FacetSuggestionService'
import { parseInput } from '../ingest/identifiers'
import type { JobQueue } from '../jobs/JobQueue'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { limitsFromConfig, operationCap } from '../llm/BudgetGuard'
import { ACTION_INPUTS, READ_PAGE_LIMIT, type ActionInput } from '../mcp/actionTools'
import { ToolError } from '../mcp/libraryTools'
import { ConflictError } from '../project/errors'
import type { ProjectStore } from '../project/ProjectStore'
import type { RelationService } from '../relations/RelationService'
import { loadForm } from '../summary/extractionForm'
import { editFacet, editField, InvalidEdit, type FacetPatch } from '../summary/merge'
import { editThesisRelation, type ThesisPatch } from '../summary/thesis'
import type { SummaryService } from '../summary/SummaryService'
import type { SyncService } from '../sync/SyncService'
import type { ActionExecutor, ExecutedAction, PreparedAction } from './actionTypes'
import { appendBlock } from './ChatService'

export interface ChatActionsDeps {
  store: ProjectStore
  cache: IndexCache
  /** The session's own trash reads, tracked like the UI's so closing the project waits for them. */
  listTrash: () => Promise<TrashEntry[]>
  deletePlan: (target: TrashTarget) => Promise<DeletePlan>
  queue: JobQueue
  summaries: SummaryService
  relations: RelationService
  facets: FacetSuggestionService
  sync: SyncService
  /** The learned estimate of one call of `operation` (the session's BudgetGuard). */
  estimate: (operation: CostOperation) => number
  /** The session's own trash operations: they also update the neighbours and hold off the automatic sync. */
  trash: (ids: string[]) => Promise<TrashOutcome>
  restore: (ids: string[], opts: { merge: boolean }) => Promise<RestoreOutcome>
  deleteForever: (ids: string[]) => Promise<number>
  now?: () => Date
  /** How long add_paper and attach_pdf wait for their job before saying it goes on in Actividad (60 s). */
  jobWaitMs?: number
}

const DEFAULT_JOB_WAIT_MS = 60_000
const MAX_NOTE_ATTEMPTS = 3
/** Longest edit_summary value, as JSON (a note's own limit). */
const MAX_EDIT_CHARS = 20_000
/** Longest rationale or justification a read tool returns (the ids matter; the full text is in the app). */
const MAX_READ_TEXT = 300

const clip = (text: string): string => (text.length > MAX_READ_TEXT ? `${text.slice(0, MAX_READ_TEXT - 1)}…` : text)
/** One page of a read tool's list, and where the next one starts (null: this was the last). */
function pageOf<T>(items: T[], args: { offset?: number; limit?: number }) {
  const offset = args.offset ?? 0
  const limit = args.limit ?? READ_PAGE_LIMIT
  const end = offset + limit
  return { total: items.length, offset, items: items.slice(offset, end), next_offset: end < items.length ? end : null }
}

const isCode = (v: unknown): v is UserErrorCode => typeof v === 'string' && (USER_ERROR_CODES as readonly string[]).includes(v)
const jobError = (r: JobRecord): UserFacingError => new UserFacingError(isCode(r.message) ? r.message : 'unknown')
const unique = (ids: string[]): string[] => [...new Set(ids)]
/** The arguments as recorded: without the request quote, and each paper named once. */
const recorded = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args)
      .filter(([k]) => k !== 'request_quote')
      .map(([k, v]) => [k, k === 'paper_ids' && Array.isArray(v) ? unique(v as string[]) : v])
  )
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const facetKey = (key: string, what = 'facet key'): string => {
  if (!FACET_KEY_PATTERN.test(key))
    throw new ToolError(`${JSON.stringify(key)} is not a ${what}: lowercase letters, digits and underscores, starting with a letter.`)
  return key
}
const brief = (list: RelationView[]) => list.map((r) => ({ id: r.id, type: r.type, from: r.from, to: r.to, justification: clip(r.justification) }))

/** The tool's arguments, validated again here (the server already did) so each case gets them typed. */
function input<T extends ActionTool | ActionReadTool>(tool: T, args: Record<string, unknown>): ActionInput<T> {
  const parsed = z.object(ACTION_INPUTS[tool] as z.ZodRawShape).safeParse(args)
  if (!parsed.success) throw new ToolError(`Invalid arguments for ${tool}: ${z.prettifyError(parsed.error)}`)
  return parsed.data as ActionInput<T>
}

/**
 * The chat's actions over one project, through the same services as the UI's buttons (caps, write gate, validations,
 * undo). `prepare` never writes: it checks the call and describes it; only `execute` acts.
 */
export class ChatActions implements ActionExecutor {
  constructor(private readonly deps: ChatActionsDeps) {}

  async read(tool: ActionReadTool, args: Record<string, unknown>): Promise<unknown> {
    const { relations, facets, sync } = this.deps
    switch (tool) {
      case 'list_relations': {
        const { paper_id } = input('list_relations', args)
        this.requirePapers([paper_id])
        const r = relations.forPaper(paper_id)
        return { suggested: brief(r.suggested), confirmed: brief(r.confirmed), rejected: brief(r.rejected) }
      }
      case 'list_facet_suggestions': {
        const all = (await facets.list()).suggestions.map(({ suggestion: s, validity }) => ({
          id: s.id,
          kind: s.kind,
          status: s.status,
          validity,
          rationale: clip(s.rationale)
        }))
        return pageOf(all, input('list_facet_suggestions', args))
      }
      case 'list_trash': {
        const all = (await this.deps.listTrash()).map((e) => ({ paper_id: e.id, title: e.title, year: e.year, trashed_at: e.trashed_at }))
        return pageOf(all, input('list_trash', args))
      }
      case 'sync_status': {
        const s = await sync.status()
        return {
          setup: s.setup,
          phase: s.phase,
          dirty: s.dirty,
          ahead: s.ahead,
          conflicts: s.conflicts,
          last_sync_at: s.lastSyncAt,
          error: s.error?.code ?? null
        }
      }
      case 'sync_conflicts': {
        const all = (await sync.conflicts()).map((c) => ({ id: c.id, path: c.path, paper_id: c.paperId, ours: c.ours, theirs: c.theirs }))
        return pageOf(all, input('sync_conflicts', args))
      }
    }
  }

  async prepare(tool: ActionTool, call: Record<string, unknown>): Promise<PreparedAction> {
    const { store, cache, summaries, relations, facets, sync } = this.deps
    // A copy of its own: what `execute` runs is what was checked and shown, whatever the caller does with its object later.
    const raw = structuredClone(call)
    // The record's (and the card's) own copy, so nothing done to it reaches what runs.
    const args = structuredClone(recorded(input(tool, raw)))
    const make = (
      preview: ActionPreview,
      execute: PreparedAction['execute'],
      extra: Partial<Pick<PreparedAction, 'risk' | 'pickPdf'>> = {}
    ): PreparedAction => ({ tool, args, preview, risk: TOOL_RISK[tool], pickPdf: false, execute, ...extra })
    switch (tool) {
      case 'add_paper': {
        const { identifier } = input('add_paper', raw)
        if (parseInput(identifier).kind === 'invalid') throw new ToolError('That is not a DOI, an arXiv id or a URL.')
        // With automatic summaries on, adding queues a summary: it spends, so it asks with that summary's estimate.
        const spends = store.config.llm.auto_summarize
        const cost = spends ? await this.cost(1, 'summarize', this.deps.estimate('summarize'), false) : null
        return make({ papers: [], cost }, () => this.addPaper(identifier), { risk: spends ? 'spends' : null })
      }
      case 'write_note': {
        const { paper_id, text } = input('write_note', raw)
        this.requirePapers([paper_id])
        return make({ papers: this.papers([paper_id]), cost: null }, () => this.writeNote(paper_id, text))
      }
      case 'decide_relation': {
        const a = input('decide_relation', raw)
        if (a.decision === 'change_type' && !a.type) throw new ToolError('change_type needs the new type.')
        const [from, to] = a.relation_id.split('__')
        const gone = [from, to].filter((id) => !store.paperExists(id))
        if (gone.length > 0) throw new ToolError(`The relation's paper ${gone.join(', ')} is not in the library (it may be in the trash).`)
        const known = store.paperExists(from) ? relations.forPaper(from) : null
        const status = known ? (['suggested', 'confirmed', 'rejected'] as const).find((st) => known[st].some((r) => r.id === a.relation_id)) : undefined
        if (!known || !status) throw new ToolError('Unknown relation id: call list_relations for one of its papers first.')
        const current = known[status].find((r) => r.id === a.relation_id)!
        const target = { confirm: 'confirmed', reject: 'rejected', back_to_suggested: 'suggested' } as const
        if (a.decision in target && target[a.decision as keyof typeof target] === status) throw new ToolError(`The relation is already ${status}.`)
        if (a.decision === 'change_type' && a.type === current.type) throw new ToolError(`The relation already has type ${current.type}.`)
        return make({ papers: this.papers([from, to]), cost: null }, async () => {
          const token = await this.decideRelation(a)
          return { result: {}, undo: () => relations.revert(token) }
        })
      }
      case 'review_summary': {
        const a = input('review_summary', raw)
        this.requirePapers([a.paper_id])
        if (!a.section && a.status !== 'verified') throw new ToolError('Without a section only status "verified" (verify the whole summary) is possible.')
        if (a.section && a.section !== 'thesis' && !a.key) throw new ToolError('Give the key of the field or the facet.')
        if (a.section === 'fields') this.fieldKey(a.key!)
        if (a.section === 'facets') facetKey(a.key!)
        return make({ papers: this.papers([a.paper_id]), cost: null }, async () => {
          const token = a.section
            ? await summaries.setStatus(a.paper_id, a.section, a.section === 'thesis' ? 'relation' : a.key!, a.status)
            : await summaries.verifyAll(a.paper_id)
          return { result: { paper: a.paper_id }, undo: () => summaries.revert(token) }
        })
      }
      case 'edit_summary': {
        const a = input('edit_summary', raw)
        this.requirePapers([a.paper_id])
        await this.checkEdit(a)
        return make({ papers: this.papers([a.paper_id]), cost: null }, async () => {
          const token = await summaries.edit(a.paper_id, a.section, a.section === 'thesis' ? 'relation' : a.key, a.value)
          return { result: { paper: a.paper_id }, undo: () => summaries.revert(token) }
        })
      }
      case 'resolve_proposed_value': {
        const a = input('resolve_proposed_value', raw)
        if (a.decision === 'map' && !a.to) throw new ToolError('map needs the allowed value it becomes, in to.')
        facetKey(a.facet)
        if (a.decision === 'accept') facetKey(a.value, 'facet value')
        if (a.decision === 'map') facetKey(a.to!, 'facet value')
        const proposers = await this.proposers(a.facet, a.value, a.decision === 'map' ? a.to! : null)
        return make({ papers: this.papers(proposers), cost: null }, async () => {
          const token = a.decision === 'accept' ? await summaries.acceptProposed(a.facet, a.value) : await summaries.mapProposed(a.facet, a.value, a.to!)
          return { result: {}, undo: () => summaries.revert(token) }
        })
      }
      case 'decide_facet_suggestion': {
        const a = input('decide_facet_suggestion', raw)
        const found = (await facets.list()).suggestions.find((v) => v.suggestion.id === a.suggestion_id)
        if (!found) throw new ToolError('Unknown suggestion id: call list_facet_suggestions first.')
        const needs = a.decision === 'restore' ? 'rejected' : 'suggested'
        if (found.suggestion.status !== needs) throw new ToolError(`The suggestion is ${found.suggestion.status}: ${a.decision} needs one that is ${needs}.`)
        if (a.decision === 'accept' && found.validity !== 'ok') throw new ToolError('The suggestion no longer applies to the form; it can only be rejected.')
        return make({ papers: [], cost: null }, async () => {
          const id = a.suggestion_id
          const token = a.decision === 'accept' ? await facets.accept(id) : a.decision === 'reject' ? await facets.reject(id) : await facets.restore(id)
          return { result: {}, undo: () => facets.revert(token) }
        })
      }
      case 'restore_papers': {
        const paper_ids = unique(input('restore_papers', raw).paper_ids)
        const titles = new Map((await this.deps.listTrash()).map((e) => [e.id, e.title]))
        const missing = paper_ids.filter((id) => !titles.has(id))
        if (missing.length > 0) throw new ToolError(`Not in the trash: ${missing.join(', ')}. Call list_trash.`)
        return make({ papers: paper_ids.map((id) => ({ id, title: titles.get(id) ?? id })), cost: null }, () => this.restorePapers(paper_ids))
      }
      case 'attach_pdf': {
        const { paper_id, replace } = input('attach_pdf', raw)
        this.requirePapers([paper_id])
        const has = store.resolvePdf(paper_id) !== null
        if (has && replace !== true) throw new ToolError('The paper already has a PDF. Ask the user whether to replace it; then call again with replace: true.')
        return make({ papers: this.papers([paper_id]), cost: null, replacesPdf: has }, (o) => this.attachPdf(paper_id, replace === true, o.pdfPath), {
          pickPdf: true
        })
      }
      case 'summarize': {
        const paper_ids = unique(input('summarize', raw).paper_ids)
        this.requirePapers(paper_ids)
        // The papers the batch would summarize now; only these are queued when it runs (the service can only drop some).
        const eligible: string[] = []
        for (const id of paper_ids) if ((await summaries.plan([id])).count > 0) eligible.push(id)
        if (eligible.length === 0) throw new ToolError('None of these papers can be summarized now: they have no text, or a summary is already queued.')
        const plan = await summaries.plan(eligible)
        return make({ papers: this.papers(eligible), cost: await this.cost(plan.count, 'summarize', plan.estimateUsd, true) }, async () => {
          const { batchId, count } = await summaries.requestBatch({ ids: eligible })
          return { result: { queued: count, batch: batchId }, failed: count === 0, undo: null }
        })
      }
      case 'suggest_relations': {
        const paper_ids = unique(input('suggest_relations', raw).paper_ids)
        this.requirePapers(paper_ids)
        const state = relations.fileState().status
        if (state === 'conflict' || state === 'invalid')
          throw new ToolError("relations.yaml has a problem the user must resolve first, in a paper's Relaciones tab.")
        const withText = paper_ids.filter((id) => cache.getPaper(id)?.text_status === 'ok')
        if (withText.length === 0) throw new ToolError('None of these papers has text to analyze.')
        const cost = await this.cost(withText.length, 'suggest_relations', withText.length * this.deps.estimate('suggest_relations'), true)
        // Priced by hand, not with RelationService.plan: its eligibility is the unforced one, and these runs are forced.
        return make({ papers: this.papers(withText), cost }, () => this.suggestRelations(withText))
      }
      case 'suggest_facets': {
        if (loadForm(store.config.extraction_form).status !== 'ok') throw new ToolError('The extraction form has a problem the user must fix first.')
        if ((await facets.list()).running) throw new ToolError('A facet suggestion run is already queued or running; see Actividad.')
        const plan = facets.plan()
        return make({ papers: [], cost: await this.cost(1, 'suggest_facets', plan.estimateUsd, false) }, async () => {
          await facets.request()
          return { result: { queued: 1 }, undo: null }
        })
      }
      case 'fill_facets': {
        const requested = input('fill_facets', raw).paper_ids
        const paper_ids = requested ? unique(requested) : undefined
        if (paper_ids) this.requirePapers(paper_ids)
        // The papers the card lists are the only ones filled when it runs, even with no paper_ids (all papers).
        const candidates = paper_ids ?? cache.listPapers().map((r) => r.id)
        const fillable = candidates.filter((id) => summaries.fillPlan([id]).count > 0)
        if (fillable.length === 0) throw new ToolError('No paper has new facets to fill.')
        const plan = summaries.fillPlan(fillable)
        return make({ papers: this.papers(fillable), cost: await this.cost(plan.count, 'fill_facets', plan.estimateUsd, true) }, async () => {
          const { batchId, count } = summaries.requestFill(fillable)
          return { result: { queued: count, batch: batchId }, failed: count === 0, undo: null }
        })
      }
      case 'trash_papers': {
        const paper_ids = unique(input('trash_papers', raw).paper_ids)
        this.requirePapers(paper_ids)
        return make({ papers: this.papers(paper_ids), cost: null }, async () => {
          const out = await this.deps.trash(paper_ids)
          if (out.moved.length === 0) throw new UserFacingError(isCode(out.error) ? out.error : 'trash_problem')
          return { result: { moved: out.moved, ...(out.error ? { error: out.error } : {}) }, undo: () => this.restoreAgain(out.moved) }
        })
      }
      case 'delete_forever': {
        const paper_ids = unique(input('delete_forever', raw).paper_ids)
        const plan = await this.deps.deletePlan(paper_ids)
        if (plan.ids.length === 0) throw new ToolError('None of these papers is in the trash: only papers in the trash can be deleted for good.')
        const titles = new Map((await this.deps.listTrash()).map((e) => [e.id, e.title]))
        return make({ papers: plan.ids.map((id) => ({ id, title: titles.get(id) ?? id })), cost: null, relations: plan.relations }, async () => {
          const deleted = await this.deps.deleteForever(plan.ids)
          // Every planned paper left the trash before the approval: nothing was done.
          return { result: { deleted }, failed: deleted === 0, undo: null }
        })
      }
      case 'sync_now': {
        const status = await sync.status()
        if (status.setup !== 'ready') throw new ToolError(`Git sync is not set up (${status.setup}); the user sets it up in the Sincronizar view.`)
        return make({ papers: [], cost: null }, async () => {
          const r = await sync.run({ auto: false })
          return r.ok ? { result: { outcome: r.outcome }, undo: null } : { result: { sync_error: r.error.code }, failed: true, undo: null }
        })
      }
      case 'resolve_sync_conflicts': {
        const { choices } = input('resolve_sync_conflicts', raw)
        const open = new Map((await sync.conflicts()).map((c) => [c.id, c]))
        // Only ids of the conflicts listed now; the id is never used as a path.
        if (choices.some((c) => !open.has(c.id))) throw new ToolError('Unknown conflict id: call sync_conflicts first.')
        if (new Set(choices.map((c) => c.id)).size !== choices.length) throw new ToolError('Give one choice per conflict id.')
        const conflicts = choices.map((c) => ({ path: open.get(c.id)!.path, choice: c.choice }))
        return make({ papers: [], cost: null, conflicts }, async () => {
          // Conflicts resolved elsewhere meanwhile: SyncService.resolve would run a whole sync instead, which was not approved.
          const now = new Set((await sync.conflicts()).map((c) => c.id))
          if (choices.some((c) => !now.has(c.id))) throw new UserFacingError('conflict')
          // Each choice is bound to the version the card showed: a conflict that changed since stays open.
          const r = await sync.resolve(Object.fromEntries(choices.map((c) => [c.id, { choice: c.choice, version: open.get(c.id)!.version }])))
          return r.ok ? { result: { outcome: r.outcome }, undo: null } : { result: { sync_error: r.error.code }, failed: true, undo: null }
        })
      }
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private get jobWaitMs(): number {
    return this.deps.jobWaitMs ?? DEFAULT_JOB_WAIT_MS
  }

  private papers(ids: string[]): { id: string; title: string }[] {
    return ids.map((id) => ({ id, title: this.deps.cache.getPaper(id)?.title ?? id }))
  }

  private requirePapers(ids: string[]): void {
    const missing = ids.filter((id) => !this.deps.store.paperExists(id))
    if (missing.length > 0) throw new ToolError(`Not in the library: ${missing.join(', ')}.`)
  }

  private fieldKey(key: string): SummaryFieldKey {
    if (!(SUMMARY_FIELD_KEYS as readonly string[]).includes(key))
      throw new ToolError(`Unknown summary field ${key}; the fields are ${SUMMARY_FIELD_KEYS.join(', ')}.`)
    return key as SummaryFieldKey
  }

  /**
   * The edit applied, without writing, to the paper's files as they are now with the same checks as SummaryService.edit
   * (which checks again when it runs): an edit it would refuse is refused before the user is asked.
   */
  private async checkEdit(a: ActionInput<'edit_summary'>): Promise<void> {
    const { store } = this.deps
    if (a.value === undefined) throw new ToolError('Give the new value in value.')
    if (JSON.stringify(a.value).length > MAX_EDIT_CHARS) throw new ToolError(`The value is too long (at most ${MAX_EDIT_CHARS} characters).`)
    const read = async <T>(r: Promise<{ ok: true; value: T } | { ok: false } | null>, what: string): Promise<T> => {
      const file = await r.catch(() => null)
      if (!file) throw new ToolError(`The paper has no ${what} to edit.`)
      if (!file.ok) throw new ToolError(`The paper's ${what} has a problem the user must fix first.`)
      return file.value
    }
    try {
      if (a.section === 'fields') {
        editField(await read(store.readSummary(a.paper_id), 'summary'), this.fieldKey(a.key), a.value)
        return
      }
      if (a.section === 'facets') facetKey(a.key)
      if (!isObject(a.value)) throw new ToolError('value must be an object for this section; see the tool description.')
      const extraction = await read(store.readExtraction(a.paper_id), 'classification')
      if (a.section === 'thesis') {
        editThesisRelation(extraction, store.config.thesis, a.value as ThesisPatch)
        return
      }
      const form = loadForm(store.config.extraction_form)
      if (form.status !== 'ok') throw new ToolError('The extraction form has a problem the user must fix first.')
      editFacet(extraction, form.form, a.key, a.value as FacetPatch)
    } catch (error) {
      if (error instanceof InvalidEdit) throw new ToolError(`${error.message}.`)
      throw error
    }
  }

  /** The papers that proposed `value` for a choice facet (refused when none did, or `to` is not an allowed value). */
  private async proposers(facet: string, value: string, to: string | null): Promise<string[]> {
    const { store, cache } = this.deps
    const form = loadForm(store.config.extraction_form)
    if (form.status !== 'ok') throw new ToolError('The extraction form has a problem the user must fix first.')
    const usage = computeFacetOverview(form.form, await libraryExtractions(store, cache)).facets.find((f) => f.key === facet)
    if (!usage || (usage.type !== 'single' && usage.type !== 'multi')) throw new ToolError(`${facet} is not a facet with a list of values.`)
    if (to !== null && !usage.allowed.includes(to)) throw new ToolError(`${to} is not an allowed value of ${facet}: ${usage.allowed.join(', ')}.`)
    const proposed = usage.proposed.find((p) => p.value === value)
    if (!proposed) throw new ToolError(`No paper proposes ${value} for ${facet}. Proposed now: ${usage.proposed.map((p) => p.value).join(', ') || 'none'}.`)
    return proposed.papers
  }

  private async cost(count: number, operation: CostOperation, estimateUsd: number, batch: boolean): Promise<ActionCost> {
    const llm = this.deps.store.config.llm
    return {
      count,
      estimateUsd,
      perOperationUsd: operationCap(limitsFromConfig(llm), operation),
      batchCapUsd: batch ? llm.budget.per_batch_usd : null,
      monthSpentUsd: await this.deps.summaries.monthSpent(),
      monthCapUsd: llm.budget.per_month_usd
    }
  }

  private decideRelation(a: ActionInput<'decide_relation'>): Promise<string> {
    const r = this.deps.relations
    switch (a.decision) {
      case 'confirm':
        return r.setStatus(a.relation_id, 'confirmed')
      case 'reject':
        return r.setStatus(a.relation_id, 'rejected')
      case 'back_to_suggested':
        return r.setStatus(a.relation_id, 'suggested')
      case 'change_type':
        return r.changeType(a.relation_id, a.type!)
      case 'reverse':
        return r.reverse(a.relation_id)
    }
  }

  /** The same job as «Agregar»; its outcome is reported when it ends within the wait. Undo: a paper it added goes to the trash. */
  private async addPaper(identifier: string): Promise<ExecutedAction> {
    const job = this.deps.queue.enqueue({ type: 'ingest_identifier', input: identifier })
    const done = await this.deps.queue.whenDone(job, this.jobWaitMs)
    if (!done) return { result: { job, state: 'running' }, undo: null }
    if (done.state === 'cancelled') return { result: { job, state: 'cancelled' }, failed: true, undo: null }
    if (done.state !== 'done') throw jobError(done)
    const paper = done.paperId
    return { result: { paper, outcome: done.message }, undo: done.message === 'added' && paper ? () => this.trashAgain([paper]) : null }
  }

  /** The PDF the user picked, through the same job as the paper's «Adjuntar PDF». */
  private async attachPdf(paperId: string, replace: boolean, path: string | undefined): Promise<ExecutedAction> {
    if (!path) throw new UserFacingError('file_problem')
    const job = this.deps.queue.enqueue({ type: 'attach_pdf', paperId, path, replace })
    const done = await this.deps.queue.whenDone(job, this.jobWaitMs)
    if (!done) return { result: { job, state: 'running' }, undo: null }
    if (done.state === 'cancelled') return { result: { job, state: 'cancelled' }, failed: true, undo: null }
    if (done.state !== 'done') throw jobError(done)
    return { result: { paper: paperId, outcome: done.message }, undo: null }
  }

  /**
   * Forced like the paper's own «Sugerir relaciones», in one batch so the batch cap applies. Reports the jobs it really
   * queued: a paper with a forced run already queued or running gets none (an unforced queued one becomes forced, and
   * counts), and one that fails (its text gone, relations.yaml in conflict) does not stop the rest.
   */
  private async suggestRelations(ids: string[]): Promise<ExecutedAction> {
    const { cache, relations } = this.deps
    const forced = (id: string): Set<number> =>
      new Set(cache.activeJobs('suggest_relations', id).flatMap((j) => ((JSON.parse(j.spec) as { force?: boolean }).force ? [j.id] : [])))
    const batchId = randomUUID()
    let queued = 0
    const already: string[] = []
    const failed: { paper: string; error: string }[] = []
    for (const id of ids) {
      const before = forced(id)
      try {
        await relations.request(id, { force: true, batchId })
      } catch (error) {
        failed.push({ paper: id, error: toUserFacing(error).code })
        continue
      }
      if ([...forced(id)].some((job) => !before.has(job))) queued++
      else already.push(id)
    }
    return {
      result: { queued, batch: batchId, ...(already.length > 0 ? { already_queued: already } : {}), ...(failed.length > 0 ? { failed } : {}) },
      failed: queued === 0 && failed.length > 0,
      undo: null
    }
  }

  /** Appended like «Guardar en notas del paper», hash-checked and retried on a concurrent change. */
  private async writeNote(paperId: string, text: string): Promise<ExecutedAction> {
    const { store } = this.deps
    const block = `### Claude — ${this.now().toISOString().slice(0, 10)}\n\n${text.trim()}\n`
    for (let attempt = 1; ; attempt++) {
      if (!store.paperExists(paperId)) throw new UserFacingError('paper_not_in_library')
      const before = await store.readNotes(paperId)
      try {
        const hash = await store.writeNotes(paperId, appendBlock(before.text, block), before.hash)
        return { result: { paper: paperId }, undo: () => this.unwriteNote(paperId, before.text, hash) }
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= MAX_NOTE_ATTEMPTS) throw error
      }
    }
  }

  /** The notes as they were, only while they are still exactly what the action wrote. */
  private async unwriteNote(paperId: string, previous: string, written: string): Promise<void> {
    const now = await this.deps.store.readNotes(paperId)
    if (now.hash !== written) throw new InvalidEdit('The notes changed since')
    await this.deps.store.writeNotes(paperId, previous, written)
  }

  /** Never merges: a paper whose twin is back in the library stays in the trash as a conflict, for the Papelera. */
  private async restorePapers(ids: string[]): Promise<ExecutedAction> {
    const out = await this.deps.restore(ids, { merge: false })
    const keys = out.restored.map((r) => r.key)
    return {
      result: {
        restored: out.restored.map((r) => ({ paper: r.id, key: r.key })),
        conflicts: out.conflicts.map((c) => c.id),
        failed: out.failed.map((f) => ({ paper: f.id, error: f.error }))
      },
      failed: keys.length === 0,
      undo: keys.length > 0 ? () => this.trashAgain(keys) : null
    }
  }

  /**
   * Undo of an addition or a restore: only while every paper is still in the library (InvalidEdit otherwise, which spends
   * the undo). Nothing moved is a transient failure (the undo stays); a partial move cannot be retried and is refused too.
   */
  private async trashAgain(ids: string[]): Promise<void> {
    if (ids.some((id) => !this.deps.store.paperExists(id))) throw new InvalidEdit('A paper left the library since')
    const out = await this.deps.trash(ids)
    if (out.moved.length === ids.length) return
    if (out.moved.length > 0) throw new InvalidEdit(`Only ${out.moved.join(', ')} went back to the trash`)
    throw new UserFacingError(isCode(out.error) ? out.error : 'trash_problem')
  }

  /** Undo of a trashing: only while every paper is still in the trash, never merged with a twin. */
  private async restoreAgain(ids: string[]): Promise<void> {
    const { store } = this.deps
    if (ids.some((id) => !store.trashExists(id) || store.paperExists(id))) throw new InvalidEdit('A paper left the trash since')
    const out = await this.deps.restore(ids, { merge: false })
    if (out.restored.length === ids.length) return
    if (out.restored.length > 0 || out.conflicts.length > 0) throw new InvalidEdit('Not every paper could come back')
    throw new UserFacingError(isCode(out.failed[0]?.error) ? out.failed[0].error : 'trash_problem')
  }
}
