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

/** A streamable-HTTP MCP server the agent may use, reached with a bearer token. */
export interface McpEndpoint {
  name: string
  url: string
  token: string
}

/** A run where Claude may call the tools of `mcp` (and nothing else) before answering in `schema`. */
export interface AgentRequest extends CompleteRequest {
  mcp: McpEndpoint
  /** Hard cap on turns; enforced by the MCP server's call budget, and by the CLI when it supports --max-turns. */
  maxTurns: number
}

export interface LlmProvider {
  complete(req: CompleteRequest): Promise<CompleteResult>
  runAgent(req: AgentRequest): Promise<CompleteResult>
}
