import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCliProvider, cliArgs, parseCliOutput } from '../../../src/main/llm/ClaudeCliProvider'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { toUserFacing } from '../../../src/main/library/UserFacingError'
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
    ['budget', 'budget_exceeded'],
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

  it('kills a hung process after the timeout', async () => {
    const { p } = await provider('hang')
    await expect(p.complete({ ...req, timeoutMs: 300 })).rejects.toMatchObject({ code: 'llm_timeout' })
  })

  it('kills the process when the job is cancelled', async () => {
    const { p } = await provider('hang')
    const ac = new AbortController()
    const pending = p.complete({ ...req, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('becomes a user-facing error with the same code', () => {
    expect(toUserFacing(new LlmError('llm_quota')).code).toBe('llm_quota')
  })
})
