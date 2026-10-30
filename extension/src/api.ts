/**
 * The app's side: the local API's `/ext/v1/*` endpoints on 127.0.0.1. The extension talks to nothing else. Errors come
 * back as a `ConnectorError` with a code the popup translates (errors.ts).
 */

export const DEFAULT_API_URL = 'http://127.0.0.1:47823'

/** Only this computer's loopback address, with a port: the API URL can't be pointed anywhere else. */
export function normalizeApiUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null
  const port = Number(url.port || '80')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  return `http://${url.hostname}:${port}`
}

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0
  ) {
    super(code)
    this.name = 'ConnectorError'
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface Connection {
  apiUrl: string
  token: string | null
}

export interface Existing {
  key: string
  title: string
}

export interface TaskStatus {
  state: 'running' | 'done' | 'failed'
  key: string | null
  title: string | null
  outcome: 'added' | 'merged' | 'duplicate' | 'pdf_updated' | null
  error: string | null
  job: number | null
}

/**
 * One call. A request the browser could not complete is told apart: if an opaque GET reaches the app, it is there and
 * refused this extension's origin (not paired, or revoked); if not, the app is closed or its local API is off.
 */
export async function call<T>(conn: Connection, endpoint: string, body: unknown, fetchFn: FetchFn = fetch): Promise<T> {
  if (endpoint !== 'pair' && !conn.token) throw new ConnectorError('not_paired')
  let res: Response
  try {
    res = await fetchFn(`${conn.apiUrl}/ext/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(conn.token && endpoint !== 'pair' ? { authorization: `Bearer ${conn.token}` } : {}) },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store'
    })
  } catch {
    // `pair` is answered for any extension origin: failing to reach it means the app is not there.
    if (endpoint === 'pair') throw new ConnectorError('unreachable')
    throw new ConnectorError((await reachable(conn.apiUrl, fetchFn)) ? 'not_paired' : 'unreachable')
  }
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = null
  }
  if (!res.ok) throw new ConnectorError(typeof json?.error === 'string' ? json.error : `http_${res.status}`, res.status)
  return json as T
}

async function reachable(apiUrl: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    await fetchFn(`${apiUrl}/ext/v1/ping`, { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

/** Waits for a capture task; `onTick` sees each status. Gives up (`still_running`) after `timeoutMs`. */
export async function waitForTask(
  conn: Connection,
  task: string,
  opts: { fetchFn?: FetchFn; intervalMs?: number; timeoutMs?: number; onTick?: (status: TaskStatus) => void; sleep?: (ms: number) => Promise<void> } = {}
): Promise<TaskStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)
  for (;;) {
    const status = await call<TaskStatus>(conn, 'capture_status', { task }, opts.fetchFn)
    opts.onTick?.(status)
    if (status.state === 'done') return status
    if (status.state === 'failed') throw new ConnectorError(status.error ?? 'failed')
    if (Date.now() > deadline) throw new ConnectorError('still_running')
    await sleep(opts.intervalMs ?? 800)
  }
}
