import { afterEach, describe, expect, it } from 'vitest'
import { startAgentRun, toolArgsSummary } from '../../../src/main/log/agentLog'
import { appLog, MemorySink, setLogSecrets, type ConsoleOut, type LogLevel } from '../../../src/main/log/appLog'
import { LlmError } from '../../../src/main/llm/LlmProvider'
import { UserFacingError } from '../../../src/main/library/UserFacingError'
import { startActionsMcpServer } from '../../../src/main/mcp/ActionsMcpServer'
import { startLibraryMcpServer } from '../../../src/main/mcp/LibraryMcpServer'
import { callTools, stubTools } from '../../helpers/mcp'

class MemoryConsole implements ConsoleOut {
  readonly lines: string[] = []
  write(_level: LogLevel, line: string): void {
    this.lines.push(line)
  }
}

let file: MemorySink
let terminal: MemoryConsole

function capture(level: LogLevel = 'debug'): void {
  file = new MemorySink()
  terminal = new MemoryConsole()
  appLog.setSink(file)
  appLog.setConsole(terminal, level)
}

afterEach(() => {
  appLog.setSink(null)
  appLog.setConsole(null)
  setLogSecrets([])
})

const ABSTRACT =
  'We propose Drain, an online log parsing method based on a fixed depth parse tree, which encodes specially designed parsing rules in its internal nodes.'
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
const PLAIN_SECRET = 'Zq9-plainkey'

describe('toolArgsSummary', () => {
  it('keeps ids, enums, numbers and booleans; text becomes its length', () => {
    expect(toolArgsSummary({ paper_id: 'he2017drain', from: 3, to: 5 })).toEqual({ paper_id: 'he2017drain', from: 3, to: 5 })
    expect(toolArgsSummary({ query: 'log parsing methods', limit: 10 })).toEqual({ queryChars: 19, limit: 10 })
    expect(toolArgsSummary({ paper_ids: ['a2020x', 'b2021y', 'c', 'd', 'e', 'f', 'g'], replace: true })).toEqual({ paper_ids: 'a2020x,b2021y,c,d,e +2', replace: true })
    expect(toolArgsSummary({ choices: [{ id: 'x', choice: 'ours' }], value: { text: 'long' } })).toEqual({ choicesCount: 1, valueKeys: 1 })
  })

  it('never keeps text: an id-named key with free text, a quote, a note or an abstract is only counted', () => {
    const out = toolArgsSummary({ paper_id: ABSTRACT, text: ABSTRACT, request_quote: 'please add', identifier: `https://x.test/?token=${TOKEN}`, 'weird key': 'x' })
    expect(JSON.stringify(out)).not.toContain('Drain')
    expect(JSON.stringify(out)).not.toContain('please')
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(out).toEqual({ paper_idChars: ABSTRACT.length, textChars: ABSTRACT.length, request_quoteChars: 10, identifierChars: 22 + TOKEN.length, otherArgs: 1 })
  })

  it('is bounded for anything the model sends', () => {
    expect(toolArgsSummary(null)).toEqual({})
    expect(toolArgsSummary('text')).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(toolArgsSummary(many)).length).toBeLessThanOrEqual(13)
  })
})

describe('agent run log', () => {
  it('logs start, tool calls, approvals and end with the run context, without any text payload', () => {
    capture()
    setLogSecrets([PLAIN_SECRET])
    const run = startAgentRun({ kind: 'chat', subject: '20261012-1203-ab12', model: 'sonnet', capUsd: 0.25, maxTurns: 33, ids: { paper: 'he2017drain' } })
    run.tool('library', 'search_text', { query: ABSTRACT, paper_id: 'he2017drain', limit: 5 })
    run.tool('actions', 'write_note', { paper_id: PLAIN_SECRET, text: `${ABSTRACT} ${TOKEN}`, request_quote: ABSTRACT })
    run.approval('write_note', 'free', 'asked')
    run.approval('write_note', 'free', 'approved')
    run.end({ costUsd: 0.0312, turns: 5 })
    const all = [...file.lines, ...terminal.lines].join('')
    expect(all).not.toContain('Drain')
    expect(all).not.toContain('parse tree')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(PLAIN_SECRET)
    expect(terminal.lines[0]).toMatch(/^\[research\]\[chat 20261012-1203-ab12\] \d\d:\d\d:\d\d start model=sonnet cap=\$0\.25 maxTurns=33 paper=he2017drain/)
    expect(terminal.lines[1]).toContain(`tool library.search_text queryChars=${ABSTRACT.length} paper_id=he2017drain limit=5`)
    expect(terminal.lines[3]).toContain('approval write_note risk=free asked')
    expect(terminal.lines[5]).toMatch(/end ok turns=5 tools=2 \$0\.031 \d+ms/)
  })

  it('ends with the failure code, stopped when aborted, and only once', () => {
    capture()
    startAgentRun({ kind: 'relations', subject: 'zhu2020loghub', model: 'sonnet', capUsd: 1 }).fail(new LlmError('llm_timeout', 1, { estimated: true }), { costUsd: 1, estimated: true })
    startAgentRun({ kind: 'facets', model: 'sonnet', capUsd: 1 }).fail(new UserFacingError('agent_tools_unavailable'))
    const r = startAgentRun({ kind: 'screening', subject: 'm1 r2', model: 'sonnet', capUsd: 1 })
    r.fail(new DOMException('The operation was aborted.', 'AbortError'))
    r.end({ costUsd: 0 })
    const ends = terminal.lines.filter((l) => / end /.test(l))
    expect(ends).toHaveLength(3)
    expect(ends[0]).toMatch(/^\[research\]\[relations zhu2020loghub\] .* end llm_timeout .*~\$1\.000/)
    expect(ends[1]).toMatch(/^\[research\]\[facets\] .* end agent_tools_unavailable/)
    expect(ends[2]).toContain('end stopped')
  })

  it('prints nothing below the console level, and the file keeps info entries', () => {
    capture('warn')
    const run = startAgentRun({ kind: 'facets', model: 'sonnet', capUsd: 1 })
    run.tool('library', 'facet_overview', {})
    run.end({ costUsd: 0.1 })
    expect(terminal.lines).toHaveLength(0)
    expect(file.lines.map((l) => l.split(' ')[2])).toEqual(['agent_start', 'agent_tool', 'agent_end'])
  })
})

describe('MCP servers log each tool call', () => {
  it('a hostile library call: the log has the tool and the ids, never the query nor a token', async () => {
    capture()
    const run = startAgentRun({ kind: 'relations', subject: 'he2017drain', model: 'sonnet', capUsd: 1 })
    const server = await startLibraryMcpServer(stubTools(), { maxToolCalls: 1, log: run })
    try {
      await callTools(server, [
        { name: 'search_text', arguments: { query: `${ABSTRACT} ${TOKEN}`, paper_id: 'he2017drain' } },
        { name: 'read_pages', arguments: { paper_id: 'he2017drain', from: 2, to: 3 } }
      ])
    } finally {
      await server.close()
    }
    const all = [...file.lines, ...terminal.lines].join('')
    expect(all).not.toContain('Drain')
    expect(all).not.toContain(TOKEN)
    const tools = terminal.lines.filter((l) => / tool library\./.test(l))
    expect(tools[0]).toContain('[research][relations he2017drain]')
    expect(tools[0]).toContain(`tool library.search_text queryChars=${ABSTRACT.length + 1 + TOKEN.length} paper_id=he2017drain`)
    expect(tools[1]).toContain('tool library.read_pages paper_id=he2017drain from=2 to=3 refused=budget')
  })

  it('an actions call is logged by its tool and ids, never its note text', async () => {
    capture()
    const run = startAgentRun({ kind: 'chat', subject: 'c1', model: 'sonnet', capUsd: 1 })
    const server = await startActionsMcpServer({ tools: ['write_note'], maxToolCalls: 5, call: async () => ({ ok: true }), log: run })
    try {
      await callTools(server, [{ name: 'write_note', arguments: { paper_id: 'he2017drain', text: ABSTRACT, request_quote: `add ${TOKEN}` } }])
    } finally {
      await server.close()
    }
    const all = [...file.lines, ...terminal.lines].join('')
    expect(all).not.toContain('Drain')
    expect(all).not.toContain(TOKEN)
    expect(terminal.lines.some((l) => l.includes('tool actions.write_note paper_id=he2017drain textChars='))).toBe(true)
  })
})
