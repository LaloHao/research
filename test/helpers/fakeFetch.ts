import type { FetchFn } from '../../src/main/ingest/http'

export interface Route {
  url: string | RegExp
  accept?: string
  status?: number
  body?: string | Uint8Array
  headers?: Record<string, string>
}

/** A fetch that answers from a route table and records every request. Unknown URLs get a 404. */
export function routeFetch(routes: Route[]): FetchFn & { calls: { url: string; accept: string | null; userAgent: string | null }[] } {
  const calls: { url: string; accept: string | null; userAgent: string | null }[] = []
  const fn: FetchFn = async (url, init) => {
    const headers = new Headers(init?.headers)
    const accept = headers.get('accept')
    calls.push({ url, accept, userAgent: headers.get('user-agent') })
    const route = routes.find((r) => (typeof r.url === 'string' ? r.url === url : r.url.test(url)) && (!r.accept || r.accept === accept))
    if (!route) return new Response('not found', { status: 404 })
    return new Response(route.body as BodyInit ?? '', { status: route.status ?? 200, headers: route.headers })
  }
  return Object.assign(fn, { calls })
}
