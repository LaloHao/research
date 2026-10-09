import { spawn } from 'node:child_process'
import { LlmError, type CompleteRequest, type CompleteResult, type LlmErrorCode, type LlmProvider } from './LlmProvider'

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
  if (subtype?.includes('max_budget')) return 'budget_exceeded'
  if (status === 429 || /usage limit|rate limit|quota|limit (?:reached|will reset)/i.test(text)) return 'llm_quota'
  if (subtype?.includes('structured_output')) return 'llm_invalid_output'
  return 'llm_unavailable'
}

export function parseCliOutput(stdout: string, stderr: string, exitCode: number | null): CompleteResult {
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
  return { value: out.structured_output, costUsd: cost, model: Object.keys(out.modelUsage ?? {})[0] ?? 'unknown' }
}

/** Runs `claude -p` with no tools, no MCP servers, no user settings and no saved session. */
export class ClaudeCliProvider implements LlmProvider {
  constructor(
    private readonly opts: { command?: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv; defaultTimeoutMs?: number } = {}
  ) {}

  complete(req: CompleteRequest): Promise<CompleteResult> {
    return new Promise((resolve, reject) => {
      if (req.signal?.aborted) return reject(abortError())
      const child = spawn(this.opts.command ?? 'claude', [...(this.opts.prefixArgs ?? []), ...cliArgs(req)], {
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
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new LlmError('llm_timeout')))
      }, req.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      const onAbort = (): void => {
        child.kill('SIGKILL')
        finish(() => reject(abortError()))
      }
      req.signal?.addEventListener('abort', onAbort)
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('error', (error) => finish(() => reject(new LlmError('llm_unavailable', 0, { cause: error }))))
      child.on('close', (code) =>
        finish(() => {
          try {
            resolve(parseCliOutput(stdout, stderr, code))
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
