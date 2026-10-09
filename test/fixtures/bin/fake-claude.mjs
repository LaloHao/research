#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const mode = process.env.FAKE_CLAUDE_MODE ?? 'success'
const log = process.env.FAKE_CLAUDE_LOG
const counter = process.env.FAKE_CLAUDE_COUNTER
const args = process.argv.slice(2)

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
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
    case 'hang':
      setInterval(() => {}, 1000)
      return
  }
})
