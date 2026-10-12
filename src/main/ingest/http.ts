export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    /** Response headers, e.g. OpenAlex's x-ratelimit-* and Retry-After. */
    readonly headers: Headers | null = null,
    /** The server's own explanation (the `message` of a JSON error answer, e.g. OpenAlex's), at most 500 characters. */
    readonly detail: string | null = null
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
  /** Optional OpenAlex API key; sent only to api.openalex.org. */
  openalexApiKey?: string
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

const OPENALEX_HOST = 'api.openalex.org'

export function isOpenAlexUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === OPENALEX_HOST
  } catch {
    return false
  }
}

const isOpenAlex429 = (error: HttpError): boolean => error.status === 429 && isOpenAlexUrl(error.url)

/** OpenAlex says the daily budget is spent (x-ratelimit-* headers): retrying within seconds only wastes time. */
export function openalexBudgetSpent(error: HttpError): boolean {
  if (!isOpenAlex429(error) || !error.headers) return false
  return ['x-ratelimit-remaining', 'x-ratelimit-remaining-usd'].some((name) => {
    const value = error.headers!.get(name)
    return value !== null && value.trim() !== '' && Number(value) <= 0
  })
}

/**
 * A 429 from OpenAlex that means "come back tomorrow": the budget is spent, or (after the retries) it asks to wait
 * longer than we ever wait, or says nothing about when to retry.
 */
export function isOpenAlexDailyLimit(error: HttpError): boolean {
  if (!isOpenAlex429(error)) return false
  if (openalexBudgetSpent(error)) return true
  const retryAfter = Number(error.headers?.get('retry-after'))
  return !(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter * 1000 <= MAX_RETRY_AFTER_MS)
}

/** Errors are logged and shown: they must never carry the API key or the contact email. */
function redactKey(url: string): string {
  try {
    const u = new URL(url)
    const secret = ['api_key', 'mailto'].filter((name) => u.searchParams.has(name))
    if (secret.length === 0) return url
    for (const name of secret) u.searchParams.set(name, 'redacted')
    return u.toString()
  } catch {
    return url
  }
}

export const MAX_ERROR_DETAIL = 500
const MAX_ERROR_BODY = 64 * 1024

/** The `message` of a JSON error answer (OpenAlex, Crossref): what the server says was wrong; null for anything else. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const body = await res.text()
    if (body.length > MAX_ERROR_BODY) return null
    const parsed = JSON.parse(body) as unknown
    const message = typeof parsed === 'object' && parsed !== null ? (parsed as { message?: unknown }).message : undefined
    if (typeof message !== 'string') return null
    const text = message.replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, MAX_ERROR_DETAIL) : null
  } catch {
    return null
  }
}

export class HttpClient {
  private contactEmail: string
  private openalexApiKey: string

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.contactEmail = opts.contactEmail?.trim() ?? ''
    this.openalexApiKey = opts.openalexApiKey?.trim() ?? ''
  }

  setContactEmail(email: string): void {
    this.contactEmail = email.trim()
  }

  setOpenAlexApiKey(key: string): void {
    this.openalexApiKey = key.trim()
  }

  /** Crossref and OpenAlex route requests that identify a contact to their "polite" pool; no other host sees the email. */
  userAgent(url: string): string {
    return this.contactEmail && acceptsContact(url) ? `research-app/0.1 (mailto:${this.contactEmail})` : 'research-app/0.1'
  }

  /** Adds the contact email (Crossref, OpenAlex) and the OpenAlex API key; no other host sees either. */
  politeUrl(url: string): string {
    let u: URL | null = null
    if (this.contactEmail && acceptsContact(url)) {
      u = new URL(url)
      u.searchParams.set('mailto', this.contactEmail)
    }
    if (this.openalexApiKey && isOpenAlexUrl(url)) {
      u ??= new URL(url)
      u.searchParams.set('api_key', this.openalexApiKey)
    }
    return u ? u.toString() : url
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
        if (!RETRYABLE.has(res.status)) {
          // The body is only read for the answer that is given up on: it says why (e.g. OpenAlex's invalid query).
          expire(headerTimeoutMs)
          throw new HttpError(res.status, redactKey(url), res.headers, await errorDetail(res))
        }
        lastError = new HttpError(res.status, redactKey(url), res.headers)
        if (openalexBudgetSpent(lastError as HttpError)) throw lastError
        const retryAfter = Number(res.headers.get('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      } catch (error) {
        if (error instanceof HttpError && (!RETRYABLE.has(error.status) || openalexBudgetSpent(error))) throw error
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
