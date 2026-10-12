import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CLI_FLAGS, type AgentCliFlags } from './agentCliFlags'
import {
  LlmError,
  type AgentRequest,
  type ChatEvent,
  type ChatRequest,
  type ChatResult,
  type CompleteRequest,
  type CompleteResult,
  type LlmErrorCode,
  type LlmProvider,
  type McpEndpoint
} from './LlmProvider'

const DEFAULT_TIMEOUT_MS = 5 * 60_000

export function cliArgs(req: CompleteRequest): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--model',
    req.model,
    '--max-budget-usd',
    String(req.maxUsd),
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--system-prompt',
    req.system
  ]
}

export function mcpConfig(mcp: McpEndpoint): object {
  return mcpConfigs([mcp])
}

export function mcpConfigs(servers: McpEndpoint[]): object {
  return { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } }])) }
}

const allowedFor = (name: string, flags: AgentCliFlags): string => (flags.allowedTools === 'glob' ? `mcp__${name}__*` : `mcp__${name}`)

/** Only the tools of `req.mcp` are allowed; the CLI's own tools, other MCP servers and user settings are off. */
export function agentArgs(req: AgentRequest, configPath: string, flags: AgentCliFlags): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--model',
    req.model,
    '--max-budget-usd',
    String(req.maxUsd),
    ...(flags.maxTurns ? ['--max-turns', String(req.maxTurns)] : []),
    '--tools',
    '',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    allowedFor(req.mcp.name, flags),
    ...flags.permissionArgs,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    req.system
  ]
}

/**
 * A streamed chat answer: like an agent run (only the given servers' tools, nothing of the user's setup, no saved
 * session), with Markdown instead of a JSON schema. `--verbose` is passed because print mode has required it with
 * stream-json; `--include-partial-messages` makes the text arrive while it is written.
 */
export function chatArgs(req: ChatRequest, configPath: string, flags: AgentCliFlags): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    req.model,
    '--max-budget-usd',
    String(req.maxUsd),
    ...(flags.maxTurns ? ['--max-turns', String(req.maxTurns)] : []),
    '--tools',
    '',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    req.servers.map((s) => allowedFor(s.name, flags)).join(','),
    ...flags.permissionArgs,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    req.system
  ]
}

export interface CliOutput {
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  modelUsage?: Record<string, unknown>
}

export function classifyCliError(text: string, status: number | null | undefined, subtype: string | undefined): LlmErrorCode {
  // The call's own --max-budget-usd: fails that paper, never the batch (budget_exceeded is BudgetGuard.admit's refusal).
  if (subtype?.includes('max_budget')) return 'operation_budget'
  if (subtype?.includes('max_turns')) return 'llm_invalid_output'
  if (status === 429 || /usage limit|rate limit|quota|limit (?:reached|will reset)/i.test(text)) return 'llm_quota'
  if (subtype?.includes('structured_output')) return 'llm_invalid_output'
  return 'llm_unavailable'
}

/** The CLI may call a helper model too (e.g. haiku for small tasks): the one with the most output, then cost, did the work. */
function mainModel(usage: Record<string, unknown> | undefined, requested: string | undefined): string {
  const num = (v: unknown, key: string): number => {
    const n = v && typeof v === 'object' ? Number((v as Record<string, unknown>)[key]) : NaN
    return Number.isFinite(n) ? n : 0
  }
  const ranked = Object.entries(usage ?? {}).sort(([, a], [, b]) => num(b, 'outputTokens') - num(a, 'outputTokens') || num(b, 'costUSD') - num(a, 'costUSD'))
  return ranked[0]?.[0] ?? requested ?? 'unknown'
}

/** Throws the LlmError of a failed run (keeping its cost); returns the cost otherwise. */
function checkOutcome(out: CliOutput, stderr: string, exitCode: number | null): number {
  const cost = Number(out.total_cost_usd ?? 0)
  if (out.is_error || (out.subtype && out.subtype !== 'success') || (exitCode !== 0 && exitCode !== null)) {
    throw new LlmError(classifyCliError(`${out.result ?? ''}\n${stderr}`, out.api_error_status, out.subtype), cost)
  }
  return cost
}

export function parseCliOutput(stdout: string, stderr: string, exitCode: number | null, requestedModel?: string): CompleteResult {
  let out: CliOutput
  try {
    out = JSON.parse(stdout) as CliOutput
  } catch {
    throw new LlmError(classifyCliError(`${stdout}\n${stderr}`, null, undefined), 0)
  }
  const cost = checkOutcome(out, stderr, exitCode)
  if (out.structured_output === undefined || out.structured_output === null) throw new LlmError('llm_invalid_output', cost)
  return { value: out.structured_output, costUsd: cost, model: mainModel(out.modelUsage, requestedModel) }
}

export type StreamItem =
  | { kind: 'turn' }
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string }
  /** A whole assistant message: its text is used only when no partial messages arrived. */
  | { kind: 'assistant'; text: string }
  | { kind: 'result'; output: CliOutput }

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/**
 * One line of `--output-format stream-json`: the API's events wrapped as `stream_event`, whole `assistant` messages
 * and the final `result`. Events of a subagent (with a parent tool use) and anything unknown are skipped.
 */
export function parseStreamLine(line: string): StreamItem | null {
  let msg: Json | null
  try {
    msg = asObject(JSON.parse(line))
  } catch {
    return null
  }
  if (!msg || msg.parent_tool_use_id) return null
  if (msg.type === 'result') return { kind: 'result', output: msg as CliOutput }
  if (msg.type === 'assistant') {
    const content = asObject(msg.message)?.content
    const text = (Array.isArray(content) ? content : [])
      .map(asObject)
      .filter((b): b is Json => b !== null && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    return text ? { kind: 'assistant', text } : null
  }
  if (msg.type !== 'stream_event') return null
  const event = asObject(msg.event)
  if (event?.type === 'message_start') return { kind: 'turn' }
  const block = asObject(event?.content_block)
  if (event?.type === 'content_block_start' && block?.type === 'tool_use') return { kind: 'tool', name: String(block.name ?? '').split('__').pop() ?? '' }
  const delta = asObject(event?.delta)
  if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return { kind: 'delta', text: delta.text }
  return null
}

type RunInput = { input: string; maxUsd: number; signal?: AbortSignal; timeoutMs?: number }

/** Runs `claude -p`: plain completions with no tools, no MCP servers, no user settings and no saved session; agent and chat runs with only the given MCP servers' tools. */
export class ClaudeCliProvider implements LlmProvider {
  constructor(
    private readonly opts: {
      command?: string
      prefixArgs?: string[]
      env?: NodeJS.ProcessEnv
      defaultTimeoutMs?: number
      cliFlags?: AgentCliFlags
    } = {}
  ) {}

  complete(req: CompleteRequest): Promise<CompleteResult> {
    return this.runCli(cliArgs(req), req, (stdout, stderr, code) => parseCliOutput(stdout, stderr, code, req.model))
  }

  /** The token travels in a 0600 temp file (never in argv) that is removed when the run ends, however it ends. */
  runAgent(req: AgentRequest): Promise<CompleteResult> {
    return this.withMcpConfig([req.mcp], req.signal, (configPath) =>
      this.runCli(agentArgs(req, configPath, this.flags), req, (stdout, stderr, code) => parseCliOutput(stdout, stderr, code, req.model))
    )
  }

  /** Streams the answer line by line as events; the result line gives the final text, cost and model. */
  chat(req: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<ChatResult> {
    return this.withMcpConfig(req.servers, req.signal, (configPath) => {
      const state: { buffer: string; result: CliOutput | null; streamed: boolean } = { buffer: '', result: null, streamed: false }
      const handle = (line: string): void => {
        const item = parseStreamLine(line)
        // Nothing reaches the caller once it stopped the run, even from the rest of the chunk being read.
        if (!item || req.signal?.aborted) return
        if (item.kind === 'result') state.result = item.output
        else if (item.kind === 'assistant') {
          // Without partial messages, each whole message is a turn of its own.
          if (!state.streamed) {
            onEvent({ kind: 'turn' })
            onEvent({ kind: 'delta', text: item.text })
          }
        } else {
          if (item.kind === 'delta') state.streamed = true
          onEvent(item)
        }
      }
      const onStdout = (chunk: string): void => {
        state.buffer += chunk
        for (let at = state.buffer.indexOf('\n'); at >= 0; at = state.buffer.indexOf('\n')) {
          handle(state.buffer.slice(0, at))
          state.buffer = state.buffer.slice(at + 1)
        }
      }
      return this.runCli(
        chatArgs(req, configPath, this.flags),
        req,
        (stdout, stderr, code) => {
          if (state.buffer.trim()) handle(state.buffer)
          state.buffer = ''
          const out = state.result
          if (!out) throw new LlmError(classifyCliError(`${stdout}\n${stderr}`, null, undefined), 0)
          const cost = checkOutcome(out, stderr, code)
          return { text: typeof out.result === 'string' ? out.result : '', costUsd: cost, model: mainModel(out.modelUsage, req.model) }
        },
        onStdout
      )
    })
  }

  private get flags(): AgentCliFlags {
    return this.opts.cliFlags ?? AGENT_CLI_FLAGS
  }

  private async withMcpConfig<T>(servers: McpEndpoint[], signal: AbortSignal | undefined, run: (configPath: string) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw abortError()
    const dir = await mkdtemp(join(tmpdir(), 'research-mcp-'))
    const configPath = join(dir, 'mcp.json')
    try {
      await writeFile(configPath, JSON.stringify(mcpConfigs(servers)), { mode: 0o600 })
      return await run(configPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private runCli<T>(args: string[], req: RunInput, parse: (stdout: string, stderr: string, code: number | null) => T, onStdout?: (chunk: string) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (req.signal?.aborted) return reject(abortError())
      const child = spawn(this.opts.command ?? 'claude', [...(this.opts.prefixArgs ?? []), ...args], {
        env: this.opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      // Killed after it started: its real cost is unknown, so the per-operation cap it may spend is charged as an estimate.
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new LlmError('llm_timeout', req.maxUsd, { estimated: true })))
      }, req.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      const onAbort = (): void => {
        child.kill('SIGKILL')
        finish(() => reject(Object.assign(abortError(), { costUsd: req.maxUsd, estimated: true })))
      }
      req.signal?.addEventListener('abort', onAbort)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
        if (!settled) onStdout?.(d)
      })
      child.stderr.on('data', (d: string) => (stderr += d))
      child.on('error', (error) => finish(() => reject(new LlmError('llm_unavailable', 0, { cause: error }))))
      child.on('close', (code) =>
        finish(() => {
          try {
            resolve(parse(stdout, stderr, code))
          } catch (error) {
            reject(error)
          }
        })
      )
      child.stdin.on('error', () => undefined)
      child.stdin.end(req.input)
    })
  }
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}
