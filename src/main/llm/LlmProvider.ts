/** `operation_budget`: the call reached its own --max-budget-usd (fails that paper only); `budget_exceeded`: a batch or monthly cap refused it. */
export const LLM_ERROR_CODES = ['llm_unavailable', 'llm_quota', 'llm_invalid_output', 'llm_timeout', 'budget_exceeded', 'operation_budget'] as const
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number]

/** `message` is the code, so a failed job records it directly. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly costUsd = 0,
    options?: { cause?: unknown }
  ) {
    super(code, options)
    this.name = 'LlmError'
  }
}

export interface CompleteRequest {
  system: string
  /** Untrusted paper text; sent as data, never as instructions. */
  input: string
  /** JSON Schema the answer must satisfy. */
  schema: object
  model: string
  maxUsd: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CompleteResult {
  value: unknown
  costUsd: number
  model: string
}

export interface LlmProvider {
  complete(req: CompleteRequest): Promise<CompleteResult>
}
