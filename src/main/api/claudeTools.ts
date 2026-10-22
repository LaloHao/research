import { z } from 'zod'
import { LLM_MODELS, type LlmModel } from '../../shared/summary'
import { MAX_CHECK_CHARS } from '../../shared/writing/api'
import { entryOutcome } from '../../shared/writing/citeCheck'
import { LATEX_OUTPUT_COMMANDS } from '../../shared/writing/convert'
import { renderProposedOutline } from '../../shared/writing/outlineProposal'
import { MAX_STYLE_CHARS, STYLE_FOCUSES } from '../../shared/writing/style'
import { detectFormat, type CiteFormat } from '../../shared/writing/citations'
import { costlyTool, type ApiContext, type ApiTool } from './registry'
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
