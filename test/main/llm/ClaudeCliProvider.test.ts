import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentArgs, chatArgs, ClaudeCliProvider, cliArgs, mcpConfig, mcpConfigs, parseCliOutput, parseStreamLine } from '../../../src/main/llm/ClaudeCliProvider'
import { failedCallCost, LlmError } from '../../../src/main/llm/LlmProvider'
import type { ChatEvent } from '../../../src/main/llm/LlmProvider'
import { toUserFacing } from '../../../src/main/library/UserFacingError'
import { startLibraryMcpServer } from '../../../src/main/mcp/LibraryMcpServer'
import { stubTools } from '../../helpers/mcp'
import { tmpDir } from '../../helpers/tmp'

const fake = fileURLToPath(new URL('../../fixtures/bin/fake-claude.mjs', import.meta.url))
const req = { system: 'sys', input: 'paper text', schema: { type: 'object' }, model: 'sonnet', maxUsd: 0.5 }

async function provider(mode: string, extra: Record<string, string> = {}) {
  const dir = await tmpDir()
  const log = join(dir, 'log.jsonl')
  const p = new ClaudeCliProvider({ command: process.execPath, prefixArgs: [fake], env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra } })
  return { p, log }
}

describe('cliArgs', () => {
  it('always isolates Claude: no tools, no MCP, no settings, no saved session', () => {
    const args = cliArgs(req)
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    for (const [flag, value] of [['--tools', ''], ['--setting-sources', ''], ['--model', 'sonnet'], ['--max-budget-usd', '0.5'], ['--system-prompt', 'sys']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual({ type: 'object' })
  })
})

describe('parseCliOutput', () => {
  it('reads structured output, cost and model from a real recording', async () => {
    const stdout = await readFile(fileURLToPath(new URL('../../fixtures/llm/cli-success.json', import.meta.url)), 'utf8')
    expect(parseCliOutput(stdout, '', 0)).toEqual({
      value: { method: 'Fine-tune BERT on 12k log lines' },
      costUsd: 0.002419,
      model: 'claude-haiku-4-5-20251001'
    })
  })

  it('names the model that did the work when several appear, and falls back to the requested one', () => {
    const out = (modelUsage?: Record<string, unknown>) => JSON.stringify({ subtype: 'success', structured_output: {}, total_cost_usd: 0.1, modelUsage })
    const usage = {
      'claude-haiku-4-5': { inputTokens: 900, outputTokens: 20, costUSD: 0.001 },
      'claude-sonnet-4-5': { inputTokens: 5000, outputTokens: 1500, costUSD: 0.09 }
    }
    expect(parseCliOutput(out(usage), '', 0, 'sonnet').model).toBe('claude-sonnet-4-5')
    expect(parseCliOutput(out({ a: { costUSD: 0.01 }, b: { costUSD: 0.2 } }), '', 0).model).toBe('b')
    expect(parseCliOutput(out(), '', 0, 'opus').model).toBe('opus')
    expect(parseCliOutput(out({}), '', 0).model).toBe('unknown')
  })
})

describe('ClaudeCliProvider', () => {
  it('sends the paper text through stdin and returns the structured output', async () => {
    const { p, log } = await provider('success', { FAKE_CLAUDE_OUTPUT: JSON.stringify({ ok: true }) })
    const result = await p.complete(req)
    expect(result.value).toEqual({ ok: true })
    const call = JSON.parse((await readFile(log, 'utf8')).trim())
    expect(call.input).toBe('paper text')
    expect(call.args).toContain('--strict-mcp-config')
  })

  it.each([
    ['quota', 'llm_quota'],
    ['auth', 'llm_unavailable'],
    ['budget', 'operation_budget'],
    ['no_structured', 'llm_invalid_output'],
    ['garbage', 'llm_unavailable']
  ])('maps %s to %s', async (mode, code) => {
    const { p } = await provider(mode)
    await expect(p.complete(req)).rejects.toMatchObject({ name: 'LlmError', code })
  })

  it('keeps the cost of a failed call', async () => {
    const { p } = await provider('budget')
    await expect(p.complete(req)).rejects.toMatchObject({ costUsd: 0.6 })
  })

  it('reports a missing CLI as unavailable', async () => {
    const p = new ClaudeCliProvider({ command: '/nonexistent/claude-binary' })
    await expect(p.complete(req)).rejects.toMatchObject({ code: 'llm_unavailable' })
  })

  it('kills a hung process after the timeout, charging the per-operation cap as an estimate', async () => {
    const { p } = await provider('hang')
    await expect(p.complete({ ...req, timeoutMs: 300 })).rejects.toMatchObject({ code: 'llm_timeout', costUsd: 0.5, estimated: true })
  })

  it('kills the process when the job is cancelled, charging the per-operation cap as an estimate', async () => {
    const { p } = await provider('hang')
    const ac = new AbortController()
    const pending = p.complete({ ...req, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    const error = await pending.catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(failedCallCost(error)).toEqual({ costUsd: 0.5, estimated: true })
  })

  it('charges nothing when cancelled before the CLI starts', async () => {
    const { p } = await provider('hang')
    const error = await p.complete({ ...req, signal: AbortSignal.abort() }).catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(failedCallCost(error)).toEqual({ costUsd: 0, estimated: false })
  })

  it('becomes a user-facing error with the same code', () => {
    expect(toUserFacing(new LlmError('llm_quota')).code).toBe('llm_quota')
  })
})

const mcp = { name: 'library', url: 'http://127.0.0.1:4100/mcp', token: 'secret-token' }
const agentReq = { ...req, mcp, maxTurns: 12 }
const flags = { allowedTools: 'glob' as const, permissionArgs: ['--permission-mode', 'dontAsk'], maxTurns: false }

describe('agentArgs', () => {
  it('allows only the library MCP tools and none of the CLI own tools', () => {
    const args = agentArgs(agentReq, '/tmp/research-mcp-x/mcp.json', flags)
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    for (const [flag, value] of [
      ['--tools', ''],
      ['--mcp-config', '/tmp/research-mcp-x/mcp.json'],
      ['--allowedTools', 'mcp__library__*'],
      ['--permission-mode', 'dontAsk'],
      ['--setting-sources', ''],
      ['--model', 'sonnet'],
      ['--max-budget-usd', '0.5'],
      ['--system-prompt', 'sys']
    ]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).not.toContain('--max-turns')
    expect(args.some((a) => a.includes('secret-token'))).toBe(false)
  })

  it('passes --max-turns only when the installed CLI supports it', () => {
    const args = agentArgs(agentReq, '/tmp/c.json', { ...flags, maxTurns: true })
    expect(args[args.indexOf('--max-turns') + 1]).toBe('12')
  })

  it('uses the allowed-tools form and permission flags the real run proved', () => {
    const args = agentArgs(agentReq, '/tmp/c.json', { allowedTools: 'server', permissionArgs: ['--permission-prompts', 'none'], maxTurns: false })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__library')
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(args).not.toContain('--permission-mode')
    expect(agentArgs(agentReq, '/tmp/c.json', { ...flags, permissionArgs: [] })).not.toContain('--permission-mode')
  })

  it('points the CLI at the server with the bearer token in the config file', () => {
    expect(mcpConfig(mcp)).toEqual({ mcpServers: { library: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer secret-token' } } } })
  })
})

describe('parseCliOutput (agent runs)', () => {
  it('reads the recorded agent run', async () => {
    const stdout = await readFile(fileURLToPath(new URL('../../fixtures/llm/agent-success.json', import.meta.url)), 'utf8')
    const result = parseCliOutput(stdout, '', 0, 'haiku')
    expect(Array.isArray((result.value as { relations: unknown[] }).relations)).toBe(true)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.model).toMatch(/haiku/)
  })

  it('reports the per-operation cap as operation_budget, so it never stops a batch', () => {
    const out = JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.5 })
    let error: unknown
    try {
      parseCliOutput(out, '', 1)
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ name: 'LlmError', code: 'operation_budget', costUsd: 0.5 })
  })

  it('treats a run stopped by the turn limit as invalid output, keeping its cost', () => {
    const out = JSON.stringify({ subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.2 })
    let error: unknown
    try {
      parseCliOutput(out, '', 1)
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ name: 'LlmError', code: 'llm_invalid_output', costUsd: 0.2 })
  })
})

describe('ClaudeCliProvider.runAgent', () => {
  it('lets the agent call the library tools over MCP and removes the temporary config', async () => {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12 })
    try {
      const { p, log } = await provider('agent', {
        FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: 'get_paper', arguments: { paper_id: 'he2017drain' } }]),
        FAKE_CLAUDE_OUTPUT: JSON.stringify({ relations: [] })
      })
      const result = await p.runAgent({ ...req, mcp: { name: 'library', url: server.url, token: server.token }, maxTurns: 12 })
      expect(result.value).toEqual({ relations: [] })
      expect(server.calls()).toEqual([{ name: 'get_paper', ok: true }])
      const [call, tools] = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(call.input).toBe('paper text')
      expect(existsSync(call.args[call.args.indexOf('--mcp-config') + 1])).toBe(false)
      expect(JSON.parse(tools.toolResults[0].content[0].text)).toMatchObject({ paper_id: 'he2017drain' })
    } finally {
      await server.close()
    }
  })

  it('maps CLI errors like complete() does', async () => {
    const { p } = await provider('quota')
    await expect(p.runAgent(agentReq)).rejects.toMatchObject({ code: 'llm_quota' })
  })

  it('kills a hung agent after the timeout and still removes the config', async () => {
    const { p, log } = await provider('hang')
    await expect(p.runAgent({ ...agentReq, timeoutMs: 300 })).rejects.toMatchObject({ code: 'llm_timeout', costUsd: 0.5, estimated: true })
    const call = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0])
    expect(existsSync(call.args[call.args.indexOf('--mcp-config') + 1])).toBe(false)
  })
})

const chatReq = { system: 'sys', input: 'question', model: 'sonnet', maxUsd: 0.5, servers: [mcp], maxTurns: 13 }

describe('chatArgs', () => {
  it('streams partial messages and allows only the given servers, with no tools, settings or saved session', () => {
    const args = chatArgs({ ...chatReq, servers: [mcp, { name: 'actions', url: 'http://127.0.0.1:1/mcp', token: 't' }] }, '/tmp/c.json', { ...flags, maxTurns: true })
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json'])
    for (const flag of ['--verbose', '--include-partial-messages', '--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(flag)
    for (const [flag, value] of [
      ['--tools', ''],
      ['--mcp-config', '/tmp/c.json'],
      ['--allowedTools', 'mcp__library__*,mcp__actions__*'],
      ['--permission-mode', 'dontAsk'],
      ['--setting-sources', ''],
      ['--model', 'sonnet'],
      ['--max-budget-usd', '0.5'],
      ['--max-turns', '13'],
      ['--system-prompt', 'sys']
    ]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(args).not.toContain('--json-schema')
    expect(args.some((a) => a.includes('secret-token'))).toBe(false)
    expect(mcpConfigs([mcp])).toEqual(mcpConfig(mcp))
  })
})

describe('parseStreamLine', () => {
  it('reads turns, tool calls, text and the result from the recorded stream, skipping the rest', async () => {
    const lines = (await readFile(fileURLToPath(new URL('../../fixtures/llm/chat-stream.jsonl', import.meta.url)), 'utf8')).trim().split('\n')
    const items = lines.map(parseStreamLine).filter((i) => i !== null)
    expect(items.map((i) => (i.kind === 'result' ? { kind: 'result', cost: i.output.total_cost_usd } : i))).toEqual([
      { kind: 'turn' },
      { kind: 'tool', name: 'search_text' },
      { kind: 'turn' },
      { kind: 'delta', text: 'Drain parses ' },
      { kind: 'delta', text: 'logs online.' },
      { kind: 'assistant', text: 'Drain parses logs online.' },
      { kind: 'result', cost: 0.0031 }
    ])
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine('[1,2]')).toBeNull()
  })
})

describe('ClaudeCliProvider.chat', () => {
  /**
   * `stopOnText`: aborted as soon as the first text arrives, like «Detener» while an answer streams. `throwOnEvent`: the
   * listener throws on every event.
   */
  async function run(mode: string, extra: Record<string, string> = {}, opts: { timeoutMs?: number; stopOnText?: boolean; throwOnEvent?: boolean } = {}) {
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 12, markData: true })
    const { p, log } = await provider(mode, extra)
    const events: ChatEvent[] = []
    const ac = new AbortController()
    try {
      const result = await p
        .chat({ ...chatReq, timeoutMs: opts.timeoutMs, signal: ac.signal, servers: [{ name: 'library', url: server.url, token: server.token }] }, (e) => {
          events.push(e)
          if (opts.stopOnText && e.kind === 'delta') ac.abort()
          if (opts.throwOnEvent) throw new Error('listener broke')
        })
        .catch((e: unknown) => e)
      return { result, events, log, calls: server.calls() }
    } finally {
      await server.close()
    }
  }

  it('streams the answer, lets the model call the tools and returns the final text, cost and model', async () => {
    const { result, events, log, calls } = await run('chat', { FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: 'get_paper', arguments: { paper_id: 'he2017drain' } }]) })
    expect(result).toEqual({ text: 'Drain parses logs online.', costUsd: 0.02, model: 'claude-sonnet-5' })
    expect(events).toEqual([
      { kind: 'turn' },
      { kind: 'tool', name: 'get_paper' },
      { kind: 'turn' },
      { kind: 'delta', text: 'Drain parses ' },
      { kind: 'delta', text: 'logs online.' }
    ])
    expect(calls).toEqual([{ name: 'get_paper', ok: true }])
    const [call, tools] = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(call.input).toBe('question')
    expect(existsSync(call.args[call.args.indexOf('--mcp-config') + 1])).toBe(false)
    expect(tools.toolResults[0].content[0].text.startsWith('<library_data>\n')).toBe(true)
  })

  it('maps an error result like the other runs, keeping its cost', async () => {
    const { result } = await run('chat_quota')
    expect(result).toMatchObject({ name: 'LlmError', code: 'llm_quota' })
  })

  it('stops when cancelled after text arrived, charging the cap as an estimate', async () => {
    const { result, events } = await run('chat_hang', {}, { stopOnText: true })
    expect(result).toMatchObject({ name: 'AbortError' })
    expect(failedCallCost(result)).toEqual({ costUsd: 0.5, estimated: true })
    // Nothing after the stop reaches the listener, even lines of the chunk being read.
    expect(events.filter((e) => e.kind === 'delta')).toEqual([{ kind: 'delta', text: 'Drain parses ' }])
  })

  it('times out like an agent run', async () => {
    const { result } = await run('chat_hang', {}, { timeoutMs: 300 })
    expect(result).toMatchObject({ code: 'llm_timeout', costUsd: 0.5, estimated: true })
  })

  it('keeps streaming and returns the result and cost when the listener throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { result, events } = await run('chat', {}, { throwOnEvent: true })
      expect(result).toEqual({ text: 'Drain parses logs online.', costUsd: 0.02, model: 'claude-sonnet-5' })
      expect(events).toEqual([{ kind: 'turn' }, { kind: 'delta', text: 'Drain parses ' }, { kind: 'delta', text: 'logs online.' }])
      expect(logged).toHaveBeenCalledTimes(3)
    } finally {
      logged.mockRestore()
    }
  })

  it('reads lines and UTF-8 characters split across chunks, and a last line with no newline', async () => {
    const { result, events } = await run('chat_split', { FAKE_CLAUDE_DELTAS: JSON.stringify(['Café ', 'costó 5 €.']) })
    expect(result).toEqual({ text: 'Café costó 5 €.', costUsd: 0.02, model: 'claude-sonnet-5' })
    expect(events).toEqual([{ kind: 'turn' }, { kind: 'delta', text: 'Café ' }, { kind: 'delta', text: 'costó 5 €.' }])
  })

  it('charges the cap as an estimate when the CLI dies after streaming, never classifying the streamed text', async () => {
    const { result } = await run('chat_cut', { FAKE_CLAUDE_DELTAS: JSON.stringify(['The rate limit and quota ', 'of the parser.']) })
    expect(result).toMatchObject({ name: 'LlmError', code: 'llm_unavailable', costUsd: 0.5, estimated: true })
  })

  it('charges nothing when the CLI fails before streaming anything', async () => {
    const { result } = await run('garbage')
    expect(result).toMatchObject({ name: 'LlmError', code: 'llm_unavailable', costUsd: 0, estimated: false })
  })
})
