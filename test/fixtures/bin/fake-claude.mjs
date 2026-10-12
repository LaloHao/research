#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const mode = process.env.FAKE_CLAUDE_MODE ?? 'success'
const log = process.env.FAKE_CLAUDE_LOG
const counter = process.env.FAKE_CLAUDE_COUNTER
const args = process.argv.slice(2)

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  if (log) appendFileSync(log, JSON.stringify({ args, input }) + '\n')
  let call = 0
  if (counter) {
    call = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 0
    writeFileSync(counter, String(call))
  }
  const base = JSON.parse(readFileSync(new URL('../llm/cli-success.json', import.meta.url), 'utf8'))
  const structured = process.env.FAKE_CLAUDE_OUTPUT ? JSON.parse(process.env.FAKE_CLAUDE_OUTPUT) : base.structured_output
  switch (mode) {
    case 'success':
      process.stdout.write(JSON.stringify({ ...base, structured_output: structured }))
      return process.exit(0)
    case 'no_structured':
      process.stdout.write(JSON.stringify({ ...base, structured_output: undefined }))
      return process.exit(0)
    case 'quota':
      process.stdout.write(JSON.stringify({ ...base, subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'Claude usage limit reached. Your limit will reset at 5pm.', structured_output: undefined, total_cost_usd: 0 }))
      return process.exit(1)
    case 'auth':
      process.stdout.write(JSON.stringify({ ...base, subtype: 'error_during_execution', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login', structured_output: undefined, total_cost_usd: 0 }))
      return process.exit(1)
    case 'budget':
      process.stdout.write(JSON.stringify({ ...base, subtype: 'error_max_budget_usd', is_error: true, structured_output: undefined, total_cost_usd: 0.6 }))
      return process.exit(1)
    case 'garbage':
      process.stdout.write('not json at all')
      return process.exit(1)
    case 'agent': {
      const configPath = args[args.indexOf('--mcp-config') + 1]
      const server = Object.values(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers)[0]
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: 'fake-claude', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
      const toolResults = []
      for (const call of JSON.parse(process.env.FAKE_CLAUDE_TOOL_CALLS ?? '[]')) toolResults.push(await client.callTool(call))
      await client.close()
      if (log) appendFileSync(log, JSON.stringify({ toolResults }) + '\n')
      const agentBase = JSON.parse(readFileSync(new URL('../llm/agent-success.json', import.meta.url), 'utf8'))
      const output = process.env.FAKE_CLAUDE_OUTPUT ? JSON.parse(process.env.FAKE_CLAUDE_OUTPUT) : agentBase.structured_output
      process.stdout.write(JSON.stringify({ ...agentBase, structured_output: output }))
      return process.exit(0)
    }
    case 'chat':
    case 'chat_hang': {
      const emit = (o) => process.stdout.write(JSON.stringify({ ...o, parent_tool_use_id: null, session_id: 'fake' }) + '\n')
      const configPath = args[args.indexOf('--mcp-config') + 1]
      const server = Object.values(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers)[0]
      emit({ type: 'system', subtype: 'init' })
      const calls = JSON.parse(process.env.FAKE_CLAUDE_TOOL_CALLS ?? '[]')
      if (calls.length > 0) {
        emit({ type: 'stream_event', event: { type: 'message_start' } })
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        const client = new Client({ name: 'fake-claude', version: '1.0.0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
        const toolResults = []
        for (const call of calls) {
          emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: `mcp__library__${call.name}` } } })
          toolResults.push(await client.callTool(call))
        }
        await client.close()
        if (log) appendFileSync(log, JSON.stringify({ toolResults }) + '\n')
      }
      emit({ type: 'stream_event', event: { type: 'message_start' } })
      const deltas = JSON.parse(process.env.FAKE_CLAUDE_DELTAS ?? '["Drain parses ","logs online."]')
      for (const text of deltas) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
      if (mode === 'chat_hang') {
        setInterval(() => {}, 1000)
        return
      }
      const answer = deltas.join('')
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } })
      emit({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.02, modelUsage: { 'claude-sonnet-5': { outputTokens: 40, costUSD: 0.02 } } })
      return process.exit(0)
    }
    case 'chat_quota':
      process.stdout.write(
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'Claude usage limit reached.', total_cost_usd: 0 }) + '\n'
      )
      return process.exit(1)
    case 'hang':
      setInterval(() => {}, 1000)
      return
  }
})
