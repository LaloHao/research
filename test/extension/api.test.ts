import { describe, expect, it } from 'vitest'
import { call, ConnectorError, normalizeApiUrl, waitForTask, type FetchFn, type TaskStatus } from '../../extension/src/api'
import { errorMessage, outcomeMessage } from '../../extension/src/errors'

const conn = { apiUrl: 'http://127.0.0.1:47823', token: 'tok' }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof ConnectorError ? error.code : 'other'
  }
}

describe('normalizeApiUrl', () => {
  it('accepts only this computer, with a port, and nothing else in the address', () => {
    expect(normalizeApiUrl(' http://127.0.0.1:47823/ ')).toBe('http://127.0.0.1:47823')
    expect(normalizeApiUrl('http://localhost:5000')).toBe('http://localhost:5000')
    expect(normalizeApiUrl('http://[::1]:5000')).toBe('http://[::1]:5000')
    for (const bad of ['https://127.0.0.1:47823', 'http://example.org:47823', 'http://127.0.0.1:47823/ext', 'http://user@127.0.0.1:47823', 'http://127.0.0.1:80', 'not a url', 'http://127.0.0.2:47823']) {
      expect(normalizeApiUrl(bad)).toBeNull()
    }
  })
})

describe('call', () => {
  it('posts JSON with the bearer token to the extension endpoint', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetchFn: FetchFn = async (url, init) => (seen.push({ url, init }), json(200, { ok: true }))
    expect(await call(conn, 'ping', { a: 1 }, fetchFn)).toEqual({ ok: true })
    expect(seen[0]!.url).toBe('http://127.0.0.1:47823/ext/v1/ping')
    expect(seen[0]!.init).toMatchObject({ method: 'POST', body: '{"a":1}', credentials: 'omit', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } })
  })

  it('sends no token to pair, and needs one for anything else', async () => {
    const seen: RequestInit[] = []
    await call({ ...conn, token: 'old' }, 'pair', { code: 'X' }, async (_u, init) => (seen.push(init!), json(200, { token: 'new' })))
    expect(seen[0]!.headers).not.toHaveProperty('authorization')
    expect(await codeOf(call({ ...conn, token: null }, 'ping', {}, async () => json(200, {})))).toBe('not_paired')
  })

  it('maps the app\'s error answers to their codes', async () => {
    expect(await codeOf(call(conn, 'capture_lookup', {}, async () => json(409, { error: 'no_project' })))).toBe('no_project')
    expect(await codeOf(call(conn, 'capture_lookup', {}, async () => new Response('', { status: 500 })))).toBe('http_500')
  })

  it('tells «not paired» (the app answers an opaque ping) from «not running» (nothing answers)', async () => {
    const refused: FetchFn = async (_url, init) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 })
      throw new TypeError('NetworkError when attempting to fetch resource.')
    }
    expect(await codeOf(call(conn, 'ping', {}, refused))).toBe('not_paired')
    const down: FetchFn = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await codeOf(call(conn, 'ping', {}, down))).toBe('unreachable')
    expect(await codeOf(call(conn, 'pair', { code: 'X' }, refused))).toBe('unreachable')
  })
})

describe('waitForTask', () => {
  const status = (state: TaskStatus['state'], extra: Partial<TaskStatus> = {}): TaskStatus => ({ state, key: null, title: null, outcome: null, error: null, job: null, ...extra })

  it('polls until the task is done, and fails with its error code', async () => {
    const answers = [status('running'), status('running'), status('done', { key: 'smith2020deep', outcome: 'added' })]
    const ticks: string[] = []
    const done = await waitForTask(conn, 't1', { fetchFn: async () => json(200, answers.shift()), sleep: async () => undefined, onTick: (s) => void ticks.push(s.state) })
    expect(done.key).toBe('smith2020deep')
    expect(ticks).toEqual(['running', 'running', 'done'])
    expect(await codeOf(waitForTask(conn, 't2', { fetchFn: async () => json(200, status('failed', { error: 'site_blocked' })), sleep: async () => undefined }))).toBe('site_blocked')
    expect(await codeOf(waitForTask(conn, 't3', { fetchFn: async () => json(200, status('running')), sleep: async () => undefined, timeoutMs: -1 }))).toBe('still_running')
  })
})

describe('messages', () => {
  it('says in Spanish what went wrong and how it ended', () => {
    expect(errorMessage('unreachable')).toContain('Research no está abierto o la API local está apagada')
    expect(errorMessage('not_paired')).toContain('Extensión no vinculada')
    expect(errorMessage('weird_code')).toBe('Algo falló (weird_code).')
    expect(outcomeMessage('added', 'smith2020deep')).toBe('Agregado como smith2020deep.')
    expect(outcomeMessage('duplicate', 'k')).toBe('Ya estaba en tu biblioteca como k.')
    expect(outcomeMessage('pdf_updated', 'k')).toBe('PDF de k actualizado.')
  })
})
