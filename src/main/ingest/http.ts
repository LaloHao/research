export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

export interface HttpClientOptions {
  fetch?: FetchFn
  contactEmail?: string
  retries?: number
  baseDelayMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_RETRY_AFTER_MS = 30_000

export class HttpClient {
  private contactEmail: string

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.contactEmail = opts.contactEmail?.trim() ?? ''
  }

  setContactEmail(email: string): void {
    this.contactEmail = email.trim()
  }

  /** Crossref and OpenAlex route requests that identify a contact to their "polite" pool. */
  userAgent(): string {
    return this.contactEmail ? `research-app/0.1 (mailto:${this.contactEmail})` : 'research-app/0.1'
  }

  politeUrl(url: string): string {
    if (!this.contactEmail) return url
    const u = new URL(url)
    u.searchParams.set('mailto', this.contactEmail)
    return u.toString()
  }

  async get(url: string, accept: string, signal?: AbortSignal): Promise<Response> {
    const fetchFn = this.opts.fetch ?? fetch
    const retries = this.opts.retries ?? 3
    const baseDelay = this.opts.baseDelayMs ?? 500
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let lastError: unknown
    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | undefined
      try {
        const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)
        const res = await fetchFn(url, {
          headers: { Accept: accept, 'User-Agent': this.userAgent() },
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
        if (res.ok) return res
        lastError = new HttpError(res.status, url)
        if (!RETRYABLE.has(res.status)) throw lastError
        const retryAfter = Number(res.headers.get('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      } catch (error) {
        if (error instanceof HttpError && !RETRYABLE.has(error.status)) throw error
        if (signal?.aborted) throw error
        lastError = error
      }
      if (attempt >= retries) throw lastError
      await sleep(retryAfterMs ?? baseDelay * 2 ** attempt)
    }
  }

  async text(url: string, accept: string, signal?: AbortSignal): Promise<string> {
    return (await this.get(url, accept, signal)).text()
  }

  async json<T = unknown>(url: string, accept = 'application/json', signal?: AbortSignal): Promise<T> {
    return (await (await this.get(url, accept, signal)).json()) as T
  }

  async bytes(url: string, accept: string, signal?: AbortSignal): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(url, accept, signal)).arrayBuffer())
  }
}
