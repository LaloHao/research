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
  /** Time to receive the response headers, and to read a small (text/JSON) body. */
  timeoutMs?: number
  /** Time to read a large body such as a PDF, counted once the headers arrive. */
  downloadTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** The only hosts that may receive the contact email: DOI content negotiation, Crossref and OpenAlex. */
const CONTACT_HOSTS = new Set(['doi.org', 'dx.doi.org', 'api.crossref.org', 'api.openalex.org'])

function acceptsContact(url: string): boolean {
  try {
    return CONTACT_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
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

  /** Crossref and OpenAlex route requests that identify a contact to their "polite" pool; no other host sees the email. */
  userAgent(url: string): string {
    return this.contactEmail && acceptsContact(url) ? `research-app/0.1 (mailto:${this.contactEmail})` : 'research-app/0.1'
  }

  politeUrl(url: string): string {
    if (!this.contactEmail || !acceptsContact(url)) return url
    const u = new URL(url)
    u.searchParams.set('mailto', this.contactEmail)
    return u.toString()
  }

  /** The body must be read within `bodyTimeoutMs` (default: the header timeout) once the headers arrive. */
  async get(url: string, accept: string, signal?: AbortSignal, bodyTimeoutMs?: number): Promise<Response> {
    const fetchFn = this.opts.fetch ?? fetch
    const retries = this.opts.retries ?? 3
    const baseDelay = this.opts.baseDelayMs ?? 500
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let lastError: unknown
    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | undefined
      try {
        const headerTimeoutMs = this.opts.timeoutMs ?? 20_000
        const timeout = new AbortController()
        const expire = (ms: number): NodeJS.Timeout => {
          const timer = setTimeout(() => timeout.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
          timer.unref?.()
          return timer
        }
        const headerTimer = expire(headerTimeoutMs)
        let res: Response
        try {
          res = await fetchFn(url, {
            headers: { Accept: accept, 'User-Agent': this.userAgent(url) },
            redirect: 'follow',
            signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
          })
        } finally {
          clearTimeout(headerTimer)
        }
        if (res.ok) {
          expire(bodyTimeoutMs ?? headerTimeoutMs)
          return res
        }
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

  /** Downloads a large body (e.g. a PDF) with the longer download timeout. */
  async bytes(url: string, accept: string, signal?: AbortSignal): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(url, accept, signal, this.downloadTimeoutMs)).arrayBuffer())
  }

  get downloadTimeoutMs(): number {
    return this.opts.downloadTimeoutMs ?? 120_000
  }
}
