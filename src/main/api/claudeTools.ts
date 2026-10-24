import { z } from 'zod'
import { PAPER_KEY } from '../../shared/chat'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import { MAX_CHECK_CHARS } from '../../shared/writing/api'
import { detectFormat, type CiteFormat } from '../../shared/writing/citations'
import { entryOutcome } from '../../shared/writing/citeCheck'
import { LATEX_OUTPUT_COMMANDS } from '../../shared/writing/convert'
import { DRAFT_ID, DRAFT_LENGTHS, exportDraft, MAX_DRAFT_PAPERS, MAX_DRAFT_PURPOSE, MAX_DRAFT_TITLE } from '../../shared/writing/draft'
import { renderProposedOutline } from '../../shared/writing/outlineProposal'
import { MAX_STYLE_CHARS, STYLE_FOCUSES } from '../../shared/writing/style'
import { UserFacingError } from '../library/UserFacingError'
import { ApiDraftRunning } from '../writing/DraftService'
import { ApiError, costlyTool, freeTool, type ApiContext, type ApiTool } from './registry'
import { codePointOffsets, format, OUTLINE_INPUT, OUTLINE_LABELS, outlineChoice } from './writingTools'

const model = z.enum(LLM_MODELS).optional().describe("sonnet, haiku or opus; the project's model when missing")
const modelOf = (ctx: ApiContext, args: { model?: LlmModel }): LlmModel => args.model ?? ctx.store.config.llm.model
const busy = (id: string | null): ApiError =>
  new ApiError('busy', `A draft started from the API is still being written${id ? ` (${id})` : ''}: wait for it with draft_status or stop it with draft_stop.`)
const formatOf = (args: { text: string; format?: CiteFormat }): CiteFormat => args.format ?? detectFormat(args.text)

/**
 * The «Redacción» operations that use Claude, for the local API. Each one is the app's own service method (the same
 * prompts, checks and caps as the window), which charges itself through `runCappedOperation`: hence `selfCapped`.
 * A check, an outline proposal or a style review stops when its caller hangs up or the project closes; a draft runs
 * in the app (it answers once started) and is followed and stopped with the free `draft_status` and `draft_stop`.
 * Offsets in their answers count characters (code points), like `check_citations_local`'s.
 */
export const CLAUDE_API_TOOLS: ApiTool[] = [
  costlyTool({
    name: 'draft',
    description:
      "«Borrador»: Claude writes a section from the chosen papers (read-only tools limited to them), every claim cited with a quote and page the app checks. Creates a new draft in the project (drafts/) and answers at once with its draft_id; the draft is written in the app (minutes): follow it with draft_status (free), stop it with draft_stop. One draft from the API at a time: while one is being written this refuses with busy. Costs Claude quota: without confirmed it answers the plan (running_draft names a draft still being written).",
    input: {
      title: z.string().trim().min(1).max(MAX_DRAFT_TITLE),
      purpose: z.string().max(MAX_DRAFT_PURPOSE).optional(),
      rq: z.string().regex(/^RQ[1-9][0-9]*$/).optional().describe('A research question of the thesis, e.g. RQ1'),
      keys: z.array(z.string().regex(PAPER_KEY)).min(1).max(MAX_DRAFT_PAPERS).describe('The papers it may cite'),
      length: z.enum(DRAFT_LENGTHS).optional().describe('short (~300 words), medium (~700, default) or long (~1500)'),
      model
    },
    cost: {
      kind: 'draft',
      model: modelOf,
      // DraftService.run admits and charges the version under the draft cap.
      selfCapped: true,
      plan: async (ctx, args) => ({ papers: new Set(args.keys).size, length: args.length ?? 'medium', running_draft: ctx.drafts.apiDraft() })
    },
    async run(ctx, args) {
      const input = { title: args.title, purpose: args.purpose ?? '', rq: args.rq ?? null, papers: args.keys, length: args.length ?? 'medium', model: modelOf(ctx, args) }
      let id: string
      try {
        // Resolves once admitted and the draft created; the version is written in the background (not tied to this call).
        id = await ctx.drafts.run(input, null, { fromApi: true })
      } catch (error) {
        if (error instanceof ApiDraftRunning) throw busy(error.draftId)
        throw error
      }
      // Charged by DraftService when the version ends; nothing is spent by this answer.
      return { draft_id: id, status: 'running', costUsd: 0, model: input.model }
    }
  }),
  freeTool({
    name: 'draft_status',
    description:
      "A draft's state: running (with the characters written so far and the tool calls), done or stopped (its last version's text in Org, LaTeX or Markdown with the counts of unverified citations, citations outside the selection and claims marked without a citation), or error with its code. Free.",
    input: {
      draft_id: z.string().regex(DRAFT_ID),
      format: format.optional().describe('org (default), latex or markdown'),
      latex_command: z.enum(LATEX_OUTPUT_COMMANDS).optional(),
      quotes: z.boolean().optional().describe("Keep each citation's verbatim quote as a comment")
    },
    async run(ctx, args) {
      const id = args.draft_id
      const progress = ctx.drafts.progress(id)
      if (progress) return { draft_id: id, status: 'running', chars: progress.chars, tools: progress.tools }
      const outcome = ctx.drafts.outcome(id)
      if (outcome?.error) return { draft_id: id, status: 'error', error: outcome.error }
      const view = await ctx.drafts.open(id).catch((error: unknown) => {
        if (error instanceof UserFacingError && error.code === 'draft_not_found') throw new ApiError('not_found', `No draft ${id}.`)
        throw error
      })
      const version = view.versions.at(-1)
      if (!version) return { draft_id: id, status: outcome?.stopped ? 'stopped' : 'error', ...(outcome?.stopped ? { text: null } : { error: 'failed' }) }
      const fmt = args.format ?? 'org'
      const exported = exportDraft(version.text, version.check, { format: fmt, latexCommand: args.latex_command, quotes: args.quotes })
      return {
        draft_id: id,
        status: version.stopped ? 'stopped' : 'done',
        title: view.summary.title,
        format: fmt,
        text: exported.text,
        unverified: version.check.unverified,
        outside: version.check.outside,
        uncited: version.check.uncited,
        costUsd: version.costUsd,
        model: version.model
      }
    }
  }),
  freeTool({
    name: 'draft_stop',
    description: "Stops a draft being written; what arrived is kept as a stopped version (draft_status then says stopped). Free.",
    input: { draft_id: z.string().regex(DRAFT_ID) },
    async run(ctx, args) {
      const running = ctx.drafts.progress(args.draft_id) !== null
      if (running) ctx.drafts.stop(args.draft_id)
      return { draft_id: args.draft_id, stopping: running }
    }
  }),
  costlyTool({
    name: 'cite_check',
    description:
      "«Verificar con Claude»: for each sentence citing papers with indexed text, whether each cited paper supports it (supports, partial, does_not_support, not_found), with the paper's quote and page the app verified. Costs Claude quota: without confirmed it answers the plan.",
    input: { text: z.string().min(1).max(MAX_CHECK_CHARS), format: format.optional(), model },
    cost: {
      kind: 'cite_check',
      model: modelOf,
      selfCapped: true,
      // The check's estimate depends on the text (calls × the learned estimate per call).
      estimate: (ctx, args) => ctx.writing.citeCheckPlan(args.text, formatOf(args), args.model),
      plan: async (ctx, args) => {
        const plan = await ctx.writing.citeCheckPlan(args.text, formatOf(args), args.model)
        return { sentences: plan.sentences, pairs: plan.pairs, batches: plan.batches, unverifiable: plan.unverifiable }
      }
    },
    async run(ctx, args, _maxUsd, signal) {
      const fmt = formatOf(args)
      const result = await ctx.writing.citeCheck({ text: args.text, format: fmt, model: args.model }, { signal })
      const at = codePointOffsets(args.text)
      return {
        format: fmt,
        counts: result.counts,
        stopped: result.stopped,
        error: result.error,
        dropped: result.dropped,
        batches: result.batches,
        checked_batches: result.checkedBatches,
        sentences: result.sentences.map((s) => ({
          start: at(s.start),
          end: at(s.end),
          text: s.text,
          citations: s.citations.map((c) => ({ start: at(c.start), end: at(c.end), keys: c.keys })),
          entries: s.entries.map((e) => ({
            key: e.key,
            outcome: entryOutcome(e),
            verdict: e.verdict,
            reason: e.reason,
            quote: e.quote,
            page: e.page,
            found: e.found,
            note: e.note
          }))
        })),
        costUsd: result.costUsd,
        model: result.model
      }
    }
  }),
  costlyTool({
    name: 'outline_proposal',
    description:
      "«Proponer redacción del esquema»: the outline (same choices as the outline tool) with Claude's headings, order, an opening per section and a sentence per gap, every citation checked by the app; rendered as Org, LaTeX or Markdown. Costs Claude quota: without confirmed it answers the plan.",
    input: {
      ...OUTLINE_INPUT,
      model,
      latex_command: z.enum(LATEX_OUTPUT_COMMANDS).optional().describe('LaTeX citation command (cite by default)'),
      quotes: z.boolean().optional().describe("Keep each citation's verbatim quote as a comment")
    },
    cost: { kind: 'outline', model: modelOf, selfCapped: true },
    async run(ctx, args, _maxUsd, signal) {
      // Checked here, so a wrong facet or question costs nothing.
      const { scope, main, secondary, question } = await outlineChoice(ctx, args)
      const run = await ctx.writing.proposeOutline({
        scope,
        facet: main.key,
        secondary: secondary?.key ?? null,
        onlyReviewed: args.reviewed_only ?? false,
        questionId: question?.id ?? null,
        model: args.model
      }, signal)
      const fmt = args.format ?? 'org'
      const rendered = renderProposedOutline(run.outline, run.proposal, {
        format: fmt,
        labels: OUTLINE_LABELS,
        latexCommand: args.latex_command,
        quotes: args.quotes,
        checks: run.checks
      })
      return { format: fmt, text: rendered.text, converted: rendered.converted, unverified: rendered.unverified, costUsd: run.costUsd, model: run.model }
    }
  }),
  costlyTool({
    name: 'style',
    description:
      "«Estilo»: Claude's style suggestions for the text, each kept only when its original is verbatim and it leaves citations, math and commands untouched; offsets of each original. Costs Claude quota: without confirmed it answers the plan.",
    input: {
      text: z.string().min(1).max(MAX_STYLE_CHARS),
      format: format.optional(),
      focus: z.array(z.enum(STYLE_FOCUSES)).min(1).optional().describe('clarity, concision, register, grammar, coherence (all by default)'),
      model
    },
    cost: { kind: 'style', model: modelOf, selfCapped: true },
    async run(ctx, args, _maxUsd, signal) {
      const fmt = formatOf(args)
      const run = await ctx.writing.reviewStyle({ text: args.text, format: fmt, focus: args.focus ?? [...STYLE_FOCUSES], model: args.model }, signal)
      const at = codePointOffsets(args.text)
      return {
        format: fmt,
        suggestions: run.suggestions.map((s) => ({
          id: s.id,
          start: at(s.start),
          end: at(s.end),
          original: s.original,
          suggestion: s.suggestion,
          reason: s.reason,
          category: s.category
        })),
        dropped: run.dropped,
        costUsd: run.costUsd,
        model: run.model
      }
    }
  })
]
