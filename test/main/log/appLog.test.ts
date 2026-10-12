import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appLog, formatEntry, jobFields, LOG_FILE, MemorySink, redact, RendererErrorGate, RotatingFileSink, setLogSecrets } from '../../../src/main/log/appLog'
import { tmpDir } from '../../helpers/tmp'

afterEach(() => {
  appLog.setSink(null)
  setLogSecrets([])
})

describe('redact', () => {
  it('hides API keys, contact emails and tokens in URLs', () => {
    expect(redact('GET https://api.openalex.org/works?filter=x&api_key=abc123&mailto=me%40uni.test')).toBe(
      'GET https://api.openalex.org/works?filter=x&api_key=redacted&mailto=redacted'
    )
    expect(redact('https://x.test/a?token=t0k&access_token=zz&password=p&key=k')).toBe('https://x.test/a?token=redacted&access_token=redacted&password=redacted&key=redacted')
  })

  it('hides emails, mailto in a User-Agent and passwords in URLs', () => {
    expect(redact('research-app/0.1 (mailto:me@uni.test)')).toBe('research-app/0.1 (mailto:redacted)')
    expect(redact('write to Ana.Lopez+x@uni.edu.mx please')).toBe('write to [email] please')
    expect(redact('git push https://user:s3cret@github.com/me/repo.git')).toBe('git push https://redacted@github.com/me/repo.git')
    expect(redact('https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x')).toBe('https://redacted@github.com/x')
  })

  it('hides Authorization headers, bearer tokens and known token shapes', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: redacted')
    expect(redact('{"authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"authorization":"redacted"}')
    expect(redact('sent Bearer eyJhbGciOi.x.y to the server')).toBe('sent Bearer redacted to the server')
    expect(redact('key sk-ant-api03-AbC_dEf-123 leaked')).toBe('key [token] leaked')
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_11ABCDEF_xyz')).toBe('[token] and [token]')
    expect(redact('password=hunter2 api_key: "zzz" secret=s')).toBe('password=redacted api_key: "redacted" secret=redacted')
  })

  it('hides the shapes a server message can echo a credential in', () => {
    expect(redact('Invalid API key: abcdef123456')).toBe('Invalid API key: redacted')
    expect(redact('{"accessToken":"a.b.c","clientSecret":"s3"}')).toBe('{"accessToken":"redacted","clientSecret":"redacted"}')
    expect(redact('apiKey=zz1 refresh_token: r1')).toBe('apiKey=redacted refresh_token: redacted')
    expect(redact('key sk-proj-AbCdEf0123456789_xyz leaked')).toBe('key [token] leaked')
    expect(redact('https://app.test/cb#access_token=xyz&state=1')).toBe('https://app.test/cb#access_token=redacted&state=1')
    expect(redact('Password = "hunter 2" then')).toBe('Password = "redacted" then')
    expect(redact("password: 'two words'")).toBe("password: 'redacted'")
  })

  it('replaces the app own secrets literally, whatever their shape, and in URL-encoded form', () => {
    setLogSecrets(['Zq9-plainkey', 'ana.lopez@uni.mx', 'abc'])
    expect(redact('OpenAlex says Zq9-plainkey is not a valid key')).toBe('OpenAlex says [secret] is not a valid key')
    expect(redact('sent by ana.lopez%40uni.mx and ANA.LOPEZ@UNI.MX')).toBe('sent by [secret] and [secret]')
    // Too short to be told from ordinary words: left to the patterns.
    expect(redact('abc')).toBe('abc')
    setLogSecrets([])
    expect(redact('Zq9-plainkey')).toBe('Zq9-plainkey')
  })

  it('leaves ordinary text alone', () => {
    expect(redact('max_tokens: 100, tokens used 5, the secret sauce')).toBe('max_tokens: 100, tokens used 5, the secret sauce')
    expect(redact('HTTP 400 on api.openalex.org/works: Wildcards (* or ?) require exact search.')).toBe(
      'HTTP 400 on api.openalex.org/works: Wildcards (* or ?) require exact search.'
    )
  })
})

describe('formatEntry', () => {
  it('writes one redacted, bounded line', () => {
    const line = formatEntry('2026-10-12T10:00:00.000Z', 'warn', 'http_failed', {
      host: 'api.openalex.org',
      status: 400,
      url: 'https://api.openalex.org/works?api_key=k',
      long: 'x'.repeat(5000),
      error: Object.assign(new Error('boom for me@uni.test'), { name: 'TypeError' })
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    expect(line).toMatch(/^2026-10-12T10:00:00\.000Z WARN http_failed \{/)
    expect(line).toContain('"status":400')
    expect(line).toContain('api_key=redacted')
    expect(line).toContain('TypeError: boom for [email]')
    expect(line).not.toContain('x'.repeat(1001))
  })

  it('keeps longer stacks in any field named stack, and never a function source', () => {
    const line = formatEntry('2026-10-12T10:00:00.000Z', 'error', 'renderer_error', { stack: 's'.repeat(3000), fn: () => 'secret source' })
    expect(line).toContain('s'.repeat(3000))
    expect(line).toContain('"fn":"[function]"')
    expect(line).not.toContain('secret source')
  })
})

describe('RotatingFileSink', () => {
  it('appends to main.log and rotates past the size, keeping three files', async () => {
    const dir = join(await tmpDir(), 'logs')
    const sink = new RotatingFileSink(dir, { maxBytes: 100, files: 3 })
    const line = (n: number): string => `${String(n).padStart(2, '0')} ${'-'.repeat(36)}\n` // 40 bytes
    for (let n = 1; n <= 12; n++) sink.write(line(n))
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', LOG_FILE])
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(100)
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe(line(11) + line(12))
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toBe(line(9) + line(10))
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toBe(line(7) + line(8))
  })

  it('continues an existing main.log and rotates it when it is already full', async () => {
    const dir = await tmpDir()
    writeFileSync(join(dir, LOG_FILE), 'x'.repeat(95))
    const sink = new RotatingFileSink(dir, { maxBytes: 100, files: 3 })
    sink.write('0123456789\n')
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toBe('x'.repeat(95))
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('0123456789\n')
  })

  it('never throws when the folder cannot be written', async () => {
    const file = join(await tmpDir(), 'not-a-dir')
    writeFileSync(file, '')
    const sink = new RotatingFileSink(join(file, 'logs'))
    expect(() => sink.write('line\n')).not.toThrow()
    expect(existsSync(join(file, 'logs'))).toBe(false)
  })
})

describe('appLog', () => {
  it('writes nothing without a sink, and to the sink once set', () => {
    appLog.info('app_start', { version: '0.1.0' })
    const sink = new MemorySink()
    appLog.setSink(sink)
    appLog.error('uncaught_exception', { error: new Error('x') })
    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).toContain('ERROR uncaught_exception')
  })
})

describe('jobFields', () => {
  it('keeps the type and ids, never a search string or a path', () => {
    expect(jobFields({ type: 'mapping_search', mappingId: 'm1', query: 'secret topic', fromYear: 2015, toYear: null, types: [], cap: 500 })).toEqual({
      type: 'mapping_search',
      mappingId: 'm1',
      queryChars: 12,
      cap: 500
    })
    expect(jobFields({ type: 'screen_suggest', mappingId: 'm1', phase: 'title_abstract', recordIds: ['a', 'b'], batchId: 'b1' })).toEqual({
      type: 'screen_suggest',
      mappingId: 'm1',
      batchId: 'b1',
      records: 2
    })
    expect(jobFields({ type: 'ingest_pdf', path: '/home/me/x.pdf' })).toEqual({ type: 'ingest_pdf' })
    expect(jobFields({ type: 'summarize', paperId: 'he2017drain', batchId: 'b' })).toEqual({ type: 'summarize', paperId: 'he2017drain', batchId: 'b' })
  })
})

describe('RendererErrorGate', () => {
  it('lets a bounded number of renderer errors through per minute', () => {
    let now = 0
    const gate = new RendererErrorGate(3, 60_000, () => now)
    expect([gate.allow(), gate.allow(), gate.allow(), gate.allow()]).toEqual([true, true, true, false])
    expect(gate.takeDropped()).toBe(1)
    expect(gate.takeDropped()).toBe(0)
    now = 60_001
    expect(gate.allow()).toBe(true)
  })
})
