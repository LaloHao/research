import { appLog, redact, scrubSecrets } from '../log/appLog'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    /** Response headers, e.g. OpenAlex's x-ratelimit-* and Retry-After. */
    readonly headers: Headers | null = null,
    /** The server's own explanation (the `message` of a JSON error answer, e.g. OpenAlex's), at most 500 characters. */
    readonly detail: string | null = null,
    /** The answer is a bot-protection page or header (Cloudflare, Akamai, …): the site refuses automated clients. */
    readonly challenge: boolean = false
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

/**
 * Headers that bot protection (Cloudflare, Akamai, Imperva, DataDome, PerimeterX, AWS WAF, Sucuri, DDoS-Guard) puts on
 * the answer it gives a client it refuses. The app never tries to get past it: it only says so.
 */
export function botProtectionHeaders(headers: Headers | null): boolean {
  if (!headers) return false
  if (headers.has('cf-mitigated') || headers.has('x-datadome') || headers.has('x-sucuri-id') || headers.has('x-amzn-waf-action')) return true
  if (/captcha|challenge/i.test(headers.get('x-px-block') ?? '') || headers.has('x-iinfo')) return true
  const server = (headers.get('server') ?? '').toLowerCase()
  return /akamaighost|ddos-guard/.test(server)
}

/** Bodies of challenge and block pages: Cloudflare's «Just a moment…», Imperva, DataDome and PerimeterX captchas. */
const CHALLENGE_BODY = /cf-chl-|challenge-platform|cf-browser-verification|<title>\s*(just a moment|attention required)|_incapsula_resource|captcha-delivery\.com|px-captcha|access denied<\/title>/i

/** The answer looks like bot protection: its headers say so, or (when read) its body is a challenge or block page. */
export function looksLikeBotProtection(status: number, headers: Headers | null, body: string | null = null): boolean {
  if (![401, 403, 429, 503].includes(status)) return false
  if (botProtectionHeaders(headers)) return true
  const server = (headers?.get('server') ?? '').toLowerCase()
  // Cloudflare answers its blocks with a 403 or a 503 challenge; a 429 or 401 from it is the origin's own.
  if (server === 'cloudflare' && (status === 403 || status === 503)) return true
  return body !== null && CHALLENGE_BODY.test(body)
}

export const MAX_ERROR_DETAIL = 500
const MAX_ERROR_BODY = 64 * 1024

/** Reads at most `max` bytes of a body; null (and the rest cancelled) when it is longer. */
async function readBounded(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * The `message` of a JSON error answer (OpenAlex, Crossref): what the server says was wrong; null for anything else.
 * It is shown and logged, so the app's own secrets (`secrets`, e.g. the API key and contact email a server may echo)
 * and anything shaped like a credential are removed first.
 */
async function errorDetail(res: Response, secrets: readonly string[]): Promise<{ detail: string | null; challenge: boolean }> {
  let body: string | null = null
  try {
    body = await readBounded(res, MAX_ERROR_BODY)
  } catch {
    // An unreadable body says nothing.
  }
  return { detail: jsonMessage(body, secrets), challenge: looksLikeBotProtection(res.status, res.headers, body) }
}

function jsonMessage(body: string | null, secrets: readonly string[]): string | null {
  try {
    if (body === null) return null
    const parsed = JSON.parse(body) as unknown
    const message = typeof parsed === 'object' && parsed !== null ? (parsed as { message?: unknown }).message : undefined
    if (typeof message !== 'string') return null
    const text = redact(scrubSecrets(message, secrets)).replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, MAX_ERROR_DETAIL) : null
  } catch {
    return null
  }
}

/** The app log gets the method, host, path, status and the server's message; never the query (keys, email) or a body. */
function logFailure(url: string, error: unknown, attempts: number): void {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname
    path = u.pathname
  } catch {
    // An unreadable URL is logged without host and path.
  }
  if (error instanceof HttpError) {
    appLog.warn('http_failed', { method: 'GET', host, path, status: error.status, detail: error.detail, attempts })
  } else {
    const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null
    appLog.warn('http_network_failed', {
      method: 'GET',
      host,
      path,
      error: typeof e?.name === 'string' ? e.name : 'Error',
      message: typeof e?.message === 'string' ? e.message : String(error),
      code: typeof e?.cause?.code === 'string' ? e.cause.code : null,
      attempts
    })
  }
}

export class HttpClient {
  private contactEmail: string
  private openalexApiKey: string

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.contactEmail = opts.contactEmail?.trim() ?? ''
    this.openalexApiKey = opts.openalexApiKey?.trim() ?? ''
  }

  /** The secrets this client holds, in the forms a server could echo them (as typed and URL-encoded). */
  private secrets(): string[] {
    return [this.openalexApiKey, this.contactEmail].filter(Boolean).flatMap((v) => [v, encodeURIComponent(v)])
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
        // A bot challenge answers the same to every retry: give up on it at once.
        if (!RETRYABLE.has(res.status) || looksLikeBotProtection(res.status, res.headers)) {
          // The body is only read for the answer that is given up on: it says why (e.g. OpenAlex's invalid query).
          expire(headerTimeoutMs)
          const { detail, challenge } = await errorDetail(res, this.secrets())
          throw new HttpError(res.status, redactKey(url), res.headers, detail, challenge)
        }
        lastError = new HttpError(res.status, redactKey(url), res.headers)
        if (openalexBudgetSpent(lastError as HttpError)) throw lastError
        const retryAfter = Number(res.headers.get('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      } catch (error) {
        if (error instanceof HttpError && (!RETRYABLE.has(error.status) || error.challenge || openalexBudgetSpent(error))) {
          // A cancellation while the error body was read is not a failure worth logging.
          if (!signal?.aborted) logFailure(url, error, attempt + 1)
          throw error
        }
        if (signal?.aborted) throw error
        lastError = error
      }
      if (attempt >= retries) {
        logFailure(url, lastError, attempt + 1)
        throw lastError
      }
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
