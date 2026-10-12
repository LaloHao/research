/** `operation_budget`: the call reached its own --max-budget-usd (fails that paper only); `budget_exceeded`: a batch or monthly cap refused it. */
export const LLM_ERROR_CODES = ['llm_unavailable', 'llm_quota', 'llm_invalid_output', 'llm_timeout', 'budget_exceeded', 'operation_budget'] as const
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number]

/**
 * `message` is the code, so a failed job records it directly. `estimated`: the CLI was cut off (timeout) before it
 * reported its cost, so `costUsd` is the per-operation cap it was allowed to spend.
 */
export class LlmError extends Error {
  readonly estimated: boolean
  constructor(
    readonly code: LlmErrorCode,
    readonly costUsd = 0,
    options?: { cause?: unknown; estimated?: boolean }
  ) {
    super(code, options)
    this.name = 'LlmError'
    this.estimated = options?.estimated ?? false
  }
}

/** What a failed call cost: an LlmError's cost, or the estimated cap a run cancelled after it started carries. */
export function failedCallCost(error: unknown): { costUsd: number; estimated: boolean } {
  if (!error || typeof error !== 'object') return { costUsd: 0, estimated: false }
  const { costUsd, estimated } = error as { costUsd?: unknown; estimated?: unknown }
  return typeof costUsd === 'number' && costUsd > 0 ? { costUsd, estimated: estimated === true } : { costUsd: 0, estimated: false }
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

/**
 * A chat answer: Markdown (no JSON schema), streamed, with the tools of `servers` and nothing else. Today the read-only
 * library server; a later stage adds its own server to this list.
 */
export interface ChatRequest {
  system: string
  /** The conversation and its context, as data. */
  input: string
  model: string
  maxUsd: number
  servers: McpEndpoint[]
  /** Tool budget plus one turn for the answer; enforced by the servers' call budget, and by the CLI when it supports --max-turns. */
  maxTurns: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** `turn`: the model starts a new turn (after a tool call), so the text shown so far is replaced. */
export type ChatEvent = { kind: 'delta'; text: string } | { kind: 'turn' } | { kind: 'tool'; name: string }

export interface ChatResult {
  /** The final turn's text. */
  text: string
  costUsd: number
  model: string
}

export interface LlmProvider {
  complete(req: CompleteRequest): Promise<CompleteResult>
  runAgent(req: AgentRequest): Promise<CompleteResult>
  chat(req: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<ChatResult>
}
