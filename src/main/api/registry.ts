import { z, type ZodRawShape } from 'zod'
import type { ApiOpenPaper } from '../../shared/localApi'
import type { CostOperation } from '../../shared/summary'
import type { IndexCache } from '../cache/IndexCache'
import { operationPlan, runCappedOperation, type CappedDeps } from '../llm/cappedOperation'
import type { LibraryTools } from '../mcp/libraryTools'
import type { ProjectStore } from '../project/ProjectStore'
import type { WritingService } from '../writing/WritingService'

/**
 * What the local API's tools work with: the open project's reads. A costly tool that needs more (the LLM provider, the
 * chat's agent runner) adds it here and in `AppController`'s `apiContext()`; tests build it from a store and a cache.
 */
export interface ApiContext {
  store: ProjectStore
  cache: IndexCache
  /** The read-only library tools of the chat and the agent runs (src/main/mcp). */
  library: LibraryTools
  writing: Pick<WritingService, 'bibFromText' | 'bibFromFile' | 'outlineData' | 'library'>
  /** Budget, ledger and caps, for `operationPlan` and `runCappedOperation`. */
  capped: CappedDeps
  /** Focuses the app's window and shows the paper at that page, the quote highlighted. */
  openInApp: (request: ApiOpenPaper) => void
}

/**
 * Codes an API caller can act on (the Emacs package translates them). A tool error reads `<code>: <message>`; anything
 * that is not an `ApiError` is reported as `failed` without its detail, but a library `ToolError` (a
 * message written for whoever called the tool) as `invalid`.
 */
export const API_ERROR_CODES = ['no_project', 'costly_disabled', 'invalid', 'not_found', 'invalid_path', 'unreadable', 'too_large', 'no_facets', 'failed'] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const noProject = (): ApiError => new ApiError('no_project', 'No project is open in the app: open one and try again.')

/** A free tool: local, read-only (or, like `open_in_app`, only touches the app's window). */
export interface FreeApiTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  input: S
  run(ctx: ApiContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>
}

/** What a costly tool's run returns: what it spent (for the ledger) and its answer. */
export interface CostlyResult {
  costUsd: number
  model: string
  [field: string]: unknown
}

/**
 * A tool that spends Claude quota (a draft, a citation check with Claude, an outline proposal, a style review). It is
 * refused unless Settings allows costly operations from the API. Without `confirmed: true` it only answers its plan
 * (`ApiPlan`: the learned estimate, its cap, the month, plus whatever `plan` adds, e.g. how many sentences it would
 * check); with it, `run` goes through `runCappedOperation` (admitted against the monthly cap, `maxUsd` its own cap,
 * charged to the ledger as `cost.kind`). `run` validates its model output itself, as the app's own operations do.
 */
export interface CostlyApiTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  input: S
  cost: {
    kind: CostOperation
    model(ctx: ApiContext, args: z.infer<z.ZodObject<S>>): string
    plan?(ctx: ApiContext, args: z.infer<z.ZodObject<S>>): Promise<Record<string, unknown>>
  }
  run(ctx: ApiContext, args: z.infer<z.ZodObject<S>>, maxUsd: number): Promise<CostlyResult>
}

// The registry holds tools of every input shape; `freeTool`/`costlyTool` keep each one typed where it is written.
export type ApiTool = FreeApiTool<any> | CostlyApiTool<any>

export const isCostly = (tool: ApiTool): tool is CostlyApiTool => 'cost' in tool

/** Typed helpers: the arguments of `run` follow the input schema. */
export const freeTool = <S extends ZodRawShape>(tool: FreeApiTool<S>): ApiTool => tool as ApiTool
export const costlyTool = <S extends ZodRawShape>(tool: CostlyApiTool<S>): ApiTool => tool as ApiTool

/** The answer of a costly tool called without `confirmed: true`. */
export interface ApiPlan {
  confirmation_required: true
  operation: CostOperation
  model: string
  estimate_usd: number
  cap_usd: number
  month_spent_usd: number
  month_cap_usd: number | null
  [field: string]: unknown
}

/** The input a tool is offered with: a costly one also takes `confirmed`. */
export function toolInput(tool: ApiTool): ZodRawShape {
  if (!isCostly(tool)) return tool.input
  return {
    ...tool.input,
    confirmed: z.boolean().optional().describe('true only after the user accepted the plan this tool answered without it (estimated cost, caps)')
  }
}

/**
 * Runs one tool call. A costly tool is refused unless `allowCostly`, answers its plan unless `confirmed` is exactly
 * true, and otherwise runs capped. `args` were already validated against `toolInput(tool)`.
 */
export async function callApiTool(tool: ApiTool, ctx: ApiContext, args: Record<string, unknown>, opts: { allowCostly: boolean }): Promise<unknown> {
  if (!isCostly(tool)) return (tool as FreeApiTool).run(ctx, args)
  if (!opts.allowCostly) throw new ApiError('costly_disabled', 'Operations that spend Claude quota are off for the local API: turn them on in Settings → Aplicación → API local.')
  const { confirmed, ...rest } = args
  const model = tool.cost.model(ctx, rest)
  if (confirmed !== true) {
    const plan = await operationPlan(ctx.capped, tool.cost.kind)
    const extra = tool.cost.plan ? await tool.cost.plan(ctx, rest) : {}
    return {
      ...extra,
      confirmation_required: true,
      operation: tool.cost.kind,
      model,
      estimate_usd: plan.estimateUsd,
      cap_usd: plan.capUsd,
      month_spent_usd: plan.monthSpentUsd,
      month_cap_usd: plan.monthCapUsd
    } satisfies ApiPlan
  }
  return runCappedOperation(ctx.capped, { kind: tool.cost.kind, model }, (maxUsd) => tool.run(ctx, rest, maxUsd))
}
