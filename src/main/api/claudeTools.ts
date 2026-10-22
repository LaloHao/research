import { z } from 'zod'
import { PAPER_KEY } from '../../shared/chat'
import type { UserErrorCode } from '../../shared/library'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import { MAX_CHECK_CHARS } from '../../shared/writing/api'
import { detectFormat, type CiteFormat } from '../../shared/writing/citations'
import { entryOutcome } from '../../shared/writing/citeCheck'
import { LATEX_OUTPUT_COMMANDS } from '../../shared/writing/convert'
import { DRAFT_LENGTHS, exportDraft, MAX_DRAFT_PAPERS, MAX_DRAFT_PURPOSE, MAX_DRAFT_TITLE } from '../../shared/writing/draft'
import { renderProposedOutline } from '../../shared/writing/outlineProposal'
import { MAX_STYLE_CHARS, STYLE_FOCUSES } from '../../shared/writing/style'
import { UserFacingError } from '../library/UserFacingError'
import { ApiError, costlyTool, type ApiContext, type ApiTool } from './registry'
import { codePointOffsets, format, OUTLINE_INPUT, OUTLINE_LABELS, outlineChoice } from './writingTools'

const model = z.enum(LLM_MODELS).optional().describe("sonnet, haiku or opus; the project's model when missing")
const modelOf = (ctx: ApiContext, args: { model?: LlmModel }): LlmModel => args.model ?? ctx.store.config.llm.model
const formatOf = (args: { text: string; format?: CiteFormat }): CiteFormat => args.format ?? detectFormat(args.text)

/**
 * The «Redacción» operations that use Claude, for the local API. Each one is the app's own service method (the same
 * prompts, checks and caps as the window), which charges itself through `runCappedOperation`: hence `selfCapped`.
 * Offsets in their answers count characters (code points), like `check_citations_local`'s.
 */
export const CLAUDE_API_TOOLS: ApiTool[] = [
  costlyTool({
    name: 'draft',
    description:
      "«Borrador»: Claude writes a section from the chosen papers (read-only tools limited to them), every claim cited with a quote and page the app checks. Creates a new draft in the project (drafts/) and answers when it is written, which can take minutes: its id and its text in Org, LaTeX or Markdown with the counts of unverified citations, citations outside the selection and claims marked without a citation. Costs Claude quota: without confirmed it answers the plan.",
    input: {
      title: z.string().trim().min(1).max(MAX_DRAFT_TITLE),
      purpose: z.string().max(MAX_DRAFT_PURPOSE).optional(),
      rq: z.string().regex(/^RQ[1-9][0-9]*$/).optional().describe('A research question of the thesis, e.g. RQ1'),
      keys: z.array(z.string().regex(PAPER_KEY)).min(1).max(MAX_DRAFT_PAPERS).describe('The papers it may cite'),
      length: z.enum(DRAFT_LENGTHS).optional().describe('short (~300 words), medium (~700, default) or long (~1500)'),
      model,
      format: format.optional().describe('org (default), latex or markdown'),
      latex_command: z.enum(LATEX_OUTPUT_COMMANDS).optional(),
      quotes: z.boolean().optional().describe("Keep each citation's verbatim quote as a comment")
    },
    cost: {
      kind: 'draft',
      model: modelOf,
      // DraftService.run admits and charges the version under the draft cap.
      selfCapped: true,
      plan: async (_ctx, args) => ({ papers: new Set(args.keys).size, length: args.length ?? 'medium' })
    },
    async run(ctx, args) {
      const id = await ctx.drafts.run(
        { title: args.title, purpose: args.purpose ?? '', rq: args.rq ?? null, papers: args.keys, length: args.length ?? 'medium', model: modelOf(ctx, args) },
        null
      )
      const outcome = await ctx.drafts.finished(id)
      const view = await ctx.drafts.open(id)
      const version = view.versions.at(-1)
      if (!version) {
        if (outcome.error) throw new UserFacingError(outcome.error as UserErrorCode)
        throw new ApiError('failed', 'The draft has no text.')
      }
      const fmt = args.format ?? 'org'
      const exported = exportDraft(version.text, version.check, { format: fmt, latexCommand: args.latex_command, quotes: args.quotes })
      return {
        draft_id: id,
        title: view.summary.title,
        format: fmt,
        text: exported.text,
        stopped: version.stopped,
        unverified: version.check.unverified,
        outside: version.check.outside,
        uncited: version.check.uncited,
        costUsd: version.costUsd,
        model: version.model
      }
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
      estimate: (ctx, args) => ctx.writing.citeCheckPlan(args.text, formatOf(args)),
      plan: async (ctx, args) => {
        const plan = await ctx.writing.citeCheckPlan(args.text, formatOf(args))
        return { sentences: plan.sentences, pairs: plan.pairs, batches: plan.batches, unverifiable: plan.unverifiable }
      }
    },
    async run(ctx, args) {
      const fmt = formatOf(args)
      const result = await ctx.writing.citeCheck({ text: args.text, format: fmt, model: args.model })
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
    async run(ctx, args) {
      // Checked here, so a wrong facet or question costs nothing.
      const { scope, main, secondary, question } = await outlineChoice(ctx, args)
      const run = await ctx.writing.proposeOutline({
        scope,
        facet: main.key,
        secondary: secondary?.key ?? null,
        onlyReviewed: args.reviewed_only ?? false,
        questionId: question?.id ?? null,
        model: args.model
      })
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
    async run(ctx, args) {
      const fmt = formatOf(args)
      const run = await ctx.writing.reviewStyle({ text: args.text, format: fmt, focus: args.focus ?? [...STYLE_FOCUSES], model: args.model })
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
