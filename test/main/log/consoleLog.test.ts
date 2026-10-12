import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { AppLog, consoleConfig, formatConsole, MemorySink, setLogSecrets, StreamConsole, type ConsoleOut, type LogLevel } from '../../../src/main/log/appLog'

afterEach(() => setLogSecrets([]))

const AT = '2026-10-12T10:03:41.000Z'

class MemoryConsole implements ConsoleOut {
  readonly lines: { level: LogLevel; line: string }[] = []
  write(level: LogLevel, line: string): void {
    this.lines.push({ level, line })
  }
}

function logWith(level: LogLevel): { log: AppLog; file: MemorySink; out: MemoryConsole } {
  const log = new AppLog(() => AT)
  const file = new MemorySink()
  const out = new MemoryConsole()
  log.setSink(file)
  log.setConsole(out, level)
  return { log, file, out }
}

describe('consoleConfig', () => {
  it('defaults to info in dev and warn in a packaged build', () => {
    expect(consoleConfig({}, false)).toEqual({ level: 'info' })
    expect(consoleConfig({}, true)).toEqual({ level: 'warn' })
  })

  it('takes RESEARCH_LOG_LEVEL and ignores an unknown one', () => {
    expect(consoleConfig({ RESEARCH_LOG_LEVEL: 'debug' }, true)).toEqual({ level: 'debug' })
    expect(consoleConfig({ RESEARCH_LOG_LEVEL: ' ERROR ' }, false)).toEqual({ level: 'error' })
    expect(consoleConfig({ RESEARCH_LOG_LEVEL: 'loud' }, false)).toEqual({ level: 'info' })
  })

  it('is turned off by RESEARCH_LOG_CONSOLE=0', () => {
    for (const v of ['0', 'false', 'off', 'no']) expect(consoleConfig({ RESEARCH_LOG_CONSOLE: v }, false)).toBeNull()
    expect(consoleConfig({ RESEARCH_LOG_CONSOLE: '1' }, false)).toEqual({ level: 'info' })
  })
})

describe('console mirror', () => {
  it('prints entries at or above its level, warn and error to stderr', () => {
    const { log, file, out } = logWith('warn')
    log.debug('d')
    log.info('job_start', { type: 'summarize', paperId: 'zhu2020loghub' })
    log.warn('http_failed', { host: 'api.openalex.org', path: '/works', status: 400, detail: 'Wildcards require exact search' })
    log.error('boom')
    expect(out.lines.map((l) => l.level)).toEqual(['warn', 'error'])
    // The file keeps info and above whatever the console's level.
    expect(file.lines).toHaveLength(3)
  })

  it('prints debug only at debug, and never writes debug to the file', () => {
    const { log, file, out } = logWith('debug')
    log.debug('agent_tool_done', { ctx: 'chat x', tool: 'read_pages', ok: true, ms: 12 })
    expect(out.lines).toHaveLength(1)
    expect(file.lines).toHaveLength(0)
  })

  it('is off without a console, and the file still gets every entry', () => {
    const log = new AppLog(() => AT)
    const file = new MemorySink()
    log.setSink(file)
    log.setConsole(null)
    log.info('app_start')
    expect(file.lines).toHaveLength(1)
  })

  it('writes to the console even without a file', () => {
    const log = new AppLog(() => AT)
    const out = new MemoryConsole()
    log.setConsole(out, 'info')
    log.info('app_start', { version: '0.1.0' })
    expect(out.lines).toHaveLength(1)
  })

  it('redacts the console line like the file line', () => {
    setLogSecrets(['Zq9-plainkey'])
    const { log, out } = logWith('info')
    log.warn('http_failed', {
      host: 'api.openalex.org',
      path: '/works',
      status: 403,
      detail: 'Invalid API key: Zq9-plainkey for me@uni.test, url https://api.openalex.org/works?api_key=abc&mailto=me%40uni.test Bearer sk-ant-api03-AbCdEfGhIjKlMnOp'
    })
    const line = out.lines[0]!.line
    expect(line).not.toContain('Zq9-plainkey')
    expect(line).not.toContain('me@uni.test')
    expect(line).not.toContain('abc&')
    expect(line).not.toContain('sk-ant-api03')
    expect(line).toContain('http 403 api.openalex.org /works')
  })

  it('a console that throws never breaks the log nor the file', () => {
    const log = new AppLog(() => AT)
    const file = new MemorySink()
    log.setSink(file)
    log.setConsole(
      {
        write: () => {
          throw new Error('EPIPE')
        }
      },
      'info'
    )
    expect(() => log.info('app_start')).not.toThrow()
    expect(file.lines).toHaveLength(1)
  })
})

describe('formatConsole', () => {
  it('is one compact line', () => {
    const line = formatConsole(AT, 'info', 'job_done', { id: 3, type: 'summarize', paperId: 'zhu2020loghub', state: 'done', outcome: null, ms: 4200 })
    expect(line).toMatch(/^\[research\] \d\d:\d\d:\d\d job:summarize ok paper=zhu2020loghub 4\.2s\n$/)
  })

  it('shows an HTTP refusal with its host, path and message', () => {
    const line = formatConsole(AT, 'warn', 'http_failed', { method: 'GET', host: 'api.openalex.org', path: '/works', status: 400, detail: 'OpenAlex: Wildcards (* or ?) require exact search.', attempts: 1 })
    expect(line).toMatch(/^\[research\] \d\d:\d\d:\d\d WARN http 400 api\.openalex\.org \/works — OpenAlex: Wildcards/)
  })

  it('prefixes agent entries with their context', () => {
    const start = formatConsole(AT, 'info', 'agent_start', { ctx: 'relations zhu2020loghub', kind: 'relations', model: 'sonnet', capUsd: 0.5, maxTurns: 12 })
    expect(start).toMatch(/^\[research\]\[relations zhu2020loghub\] \d\d:\d\d:\d\d start model=sonnet cap=\$0\.50 maxTurns=12/)
    const end = formatConsole(AT, 'info', 'agent_end', { ctx: 'chat 20261012-1203-ab12', outcome: 'ok', turns: 5, toolCalls: 3, costUsd: 0.0312, ms: 42100 })
    expect(end).toMatch(/\[research\]\[chat 20261012-1203-ab12\] \d\d:\d\d:\d\d end ok turns=5 tools=3 \$0\.031 42\.1s/)
  })

  it('keeps a multi-line message on one line', () => {
    const line = formatConsole(AT, 'error', 'job_failed', { type: 'summarize', code: 'unknown', ms: 5, error: new Error('first\nsecond') })
    expect(line.split('\n')).toHaveLength(2)
    expect(line).toContain('ERROR job:summarize failed unknown')
  })
})

class FakeStream extends EventEmitter {
  readonly written: string[] = []
  destroyed = false
  constructor(private readonly behaviour: 'ok' | 'throw' | 'async-error') {
    super()
  }
  write(chunk: string): boolean {
    if (this.behaviour === 'throw') throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    this.written.push(chunk)
    if (this.behaviour === 'async-error') setImmediate(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
    return true
  }
}

describe('StreamConsole', () => {
  it('sends info to stdout and warn/error to stderr', () => {
    const out = new FakeStream('ok')
    const err = new FakeStream('ok')
    const c = new StreamConsole(out, err)
    c.write('info', 'a\n')
    c.write('debug', 'b\n')
    c.write('warn', 'c\n')
    c.write('error', 'd\n')
    expect(out.written).toEqual(['a\n', 'b\n'])
    expect(err.written).toEqual(['c\n', 'd\n'])
  })

  it('a write that throws EPIPE turns that stream off, without throwing; the other one goes on', () => {
    const out = new FakeStream('throw')
    const err = new FakeStream('ok')
    const c = new StreamConsole(out, err)
    expect(() => c.write('info', 'a\n')).not.toThrow()
    expect(c.closed('info')).toBe(true)
    expect(c.closed('warn')).toBe(false)
    expect(() => c.write('info', 'b\n')).not.toThrow()
    c.write('warn', 'w\n')
    expect(err.written).toEqual(['w\n'])
  })

  it('an EPIPE error event is handled (never an uncaught error) and turns it off', async () => {
    const out = new FakeStream('async-error')
    const c = new StreamConsole(out, new FakeStream('ok'))
    c.write('info', 'a\n')
    await new Promise((r) => setImmediate(r))
    expect(c.closed('info')).toBe(true)
    c.write('info', 'b\n')
    expect(out.written).toEqual(['a\n'])
  })

  it('a destroyed stream is never written', () => {
    const out = new FakeStream('ok')
    out.destroyed = true
    const c = new StreamConsole(out, new FakeStream('ok'))
    const err = new FakeStream('ok')
    const c2 = new StreamConsole(out, err)
    c.write('info', 'a\n')
    c2.write('error', 'e\n')
    expect(out.written).toEqual([])
    expect(err.written).toEqual(['e\n'])
  })
})
