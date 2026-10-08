import { describe, expect, it } from 'vitest'
import { HttpClient, HttpError, type FetchFn } from '../../../src/main/ingest/http'
import { routeFetch } from '../../helpers/fakeFetch'

function sleeper(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return { delays, sleep: async (ms) => void delays.push(ms) }
}

/** Answers each call with the next status (or throws the next error); repeats the last one. */
function sequence(...steps: (number | Error | Response)[]): FetchFn & { count: () => number } {
  let i = 0
  const fn: FetchFn = async () => {
    const step = steps[Math.min(i++, steps.length - 1)]
    if (step instanceof Error) throw step
    if (step instanceof Response) return step
    return new Response(String(step), { status: step })
  }
  return Object.assign(fn, { count: () => i })
}

describe('HttpClient', () => {
  it('sends Accept and a User-Agent carrying the contact email', async () => {
    const fetch = routeFetch([{ url: 'https://x.test/a', body: 'ok' }])
    const http = new HttpClient({ fetch, contactEmail: 'me@uni.test' })
    expect(await http.text('https://x.test/a', 'text/plain')).toBe('ok')
    expect(fetch.calls[0]).toEqual({ url: 'https://x.test/a', accept: 'text/plain', userAgent: 'research-app/0.1 (mailto:me@uni.test)' })
  })

  it('omits the email from the User-Agent when none is configured', () => {
    expect(new HttpClient().userAgent()).toBe('research-app/0.1')
  })

  it('retries 5xx with exponential backoff', async () => {
    const { delays, sleep } = sleeper()
    const http = new HttpClient({ fetch: sequence(503, 503, 200), sleep })
    expect(await http.text('https://x.test', '*/*')).toBe('200')
    expect(delays).toEqual([500, 1000])
  })

  it('does not retry a 404', async () => {
    const fetch = sequence(404)
    const http = new HttpClient({ fetch, sleep: sleeper().sleep })
    await expect(http.text('https://x.test', '*/*')).rejects.toMatchObject({ name: 'HttpError', status: 404 })
    expect(fetch.count()).toBe(1)
  })

  it('gives up on network errors after the configured retries', async () => {
    const fetch = sequence(new TypeError('fetch failed'))
    const { delays, sleep } = sleeper()
    const http = new HttpClient({ fetch, retries: 2, sleep })
    await expect(http.text('https://x.test', '*/*')).rejects.toBeInstanceOf(TypeError)
    expect(fetch.count()).toBe(3)
    expect(delays).toEqual([500, 1000])
  })

  it('honors Retry-After on 429', async () => {
    const { delays, sleep } = sleeper()
    const http = new HttpClient({ fetch: sequence(new Response('', { status: 429, headers: { 'retry-after': '2' } }), 200), sleep })
    await http.text('https://x.test', '*/*')
    expect(delays).toEqual([2000])
  })

  it('adds mailto to polite-pool URLs only when an email is set', () => {
    expect(new HttpClient().politeUrl('https://api.openalex.org/works/x')).toBe('https://api.openalex.org/works/x')
    const http = new HttpClient({ contactEmail: 'me@uni.test' })
    expect(http.politeUrl('https://api.openalex.org/works/x')).toBe('https://api.openalex.org/works/x?mailto=me%40uni.test')
  })

  it('exposes HttpError with status and url', () => {
    const e = new HttpError(500, 'https://x.test')
    expect(e.message).toBe('HTTP 500 for https://x.test')
  })
})
