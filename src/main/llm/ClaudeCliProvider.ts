import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CLI_FLAGS, type AgentCliFlags } from './agentCliFlags'
import {
  LlmError,
  type AgentRequest,
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
  return { mcpServers: { [mcp.name]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }
}

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
    flags.allowedTools === 'glob' ? `mcp__${req.mcp.name}__*` : `mcp__${req.mcp.name}`,
    ...flags.permissionArgs,
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    req.system
  ]
}

interface CliOutput {
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  modelUsage?: Record<string, unknown>
}

function classify(text: string, status: number | null | undefined, subtype: string | undefined): LlmErrorCode {
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

export function parseCliOutput(stdout: string, stderr: string, exitCode: number | null, requestedModel?: string): CompleteResult {
  let out: CliOutput
  try {
    out = JSON.parse(stdout) as CliOutput
  } catch {
    throw new LlmError(classify(`${stdout}\n${stderr}`, null, undefined), 0)
  }
  const cost = Number(out.total_cost_usd ?? 0)
  if (out.is_error || (out.subtype && out.subtype !== 'success') || (exitCode !== 0 && exitCode !== null)) {
    throw new LlmError(classify(`${out.result ?? ''}\n${stderr}`, out.api_error_status, out.subtype), cost)
  }
  if (out.structured_output === undefined || out.structured_output === null) throw new LlmError('llm_invalid_output', cost)
  return { value: out.structured_output, costUsd: cost, model: mainModel(out.modelUsage, requestedModel) }
}

/** Runs `claude -p`: plain completions with no tools, no MCP servers, no user settings and no saved session; agent runs with only the given MCP server's tools. */
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
    return this.spawnCli(cliArgs(req), req)
  }

  /** The token travels in a 0600 temp file (never in argv) that is removed when the run ends, however it ends. */
  async runAgent(req: AgentRequest): Promise<CompleteResult> {
    if (req.signal?.aborted) throw abortError()
    const dir = await mkdtemp(join(tmpdir(), 'research-mcp-'))
    const configPath = join(dir, 'mcp.json')
    try {
      await writeFile(configPath, JSON.stringify(mcpConfig(req.mcp)), { mode: 0o600 })
      return await this.spawnCli(agentArgs(req, configPath, this.opts.cliFlags ?? AGENT_CLI_FLAGS), req)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private spawnCli(args: string[], req: CompleteRequest): Promise<CompleteResult> {
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
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('error', (error) => finish(() => reject(new LlmError('llm_unavailable', 0, { cause: error }))))
      child.on('close', (code) =>
        finish(() => {
          try {
            resolve(parseCliOutput(stdout, stderr, code, req.model))
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
