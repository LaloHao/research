import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { isExtensionOrigin, type PairedExtension } from '../../../shared/extension'
import { UserFacingError } from '../../library/UserFacingError'
import { CaptureFailure, type ExtensionCapture } from './capture'
import { PairingError, type ExtensionPairing } from './pairing'
import {
  identifierSchema,
  lookupSchema,
  MAX_EXTENSION_BODY,
  openSchema,
  pageSchema,
  pairSchema,
  PayloadError,
  readPage,
  statusSchema,
  updatePdfSchema
} from './payload'

/** Where the extension endpoints live; everything else of the API keeps refusing foreign origins. */
export const EXTENSION_PREFIX = '/ext/v1/'

export interface ExtensionRoutesDeps {
  pairing: ExtensionPairing
  capture: ExtensionCapture
  /** The open project's name for «Probar conexión»; null when none is open. */
  projectName: () => string | null
  version: string
  /** One line per call (endpoint, outcome, duration): never its body, never the token. */
  onCall?: (endpoint: string, status: number, ms: number) => void
}

type Handler = (body: unknown, ext: PairedExtension | null, origin: string) => Promise<unknown>

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code
  ) {
    super(message)
  }
}

const PAIRING_STATUS: Record<string, number> = { invalid_origin: 403, invalid_code: 403, rate_limited: 429, rejected: 403, timeout: 408, busy: 409 }
const CAPTURE_STATUS: Record<string, number> = { no_project: 409, not_found: 404, mismatch: 409, invalid: 400, capture_no_pdf: 422 }

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body)
  if (!result.success) throw new HttpFailure(400, 'invalid', result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return result.data
}

/**
 * The browser extension's endpoints: plain JSON over POST, CORS for paired extension origins only. `pair` is the one
 * call without a token (it needs a valid code from Settings and the user's «Aceptar»); every other call needs the
 * extension's token from the origin it was issued to. A preflight is answered only for a paired origin (and for
 * `pair`, for any extension origin). `GET ping` answers an empty 204 without CORS headers: the extension's opaque
 * request tells «la app no responde» apart from «no vinculada».
 */
export function extensionRoutes(deps: ExtensionRoutesDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const endpoints: Record<string, { auth: boolean; run: Handler }> = {
    pair: {
      auth: false,
      run: async (body, _ext, origin) => {
        const { code } = parse(pairSchema, body)
        const { token, extension } = await deps.pairing.pair({ code, origin })
        return { token, browser: extension.browser }
      }
    },
    ping: { auth: true, run: async () => ({ ok: true, version: deps.version, project: deps.projectName() }) },
    capture_lookup: { auth: true, run: async (body) => ({ existing: await deps.capture.lookup(parse(lookupSchema, body)) }) },
    capture_identifier: { auth: true, run: async (body) => deps.capture.identifier(parse(identifierSchema, body)) },
    capture_page: {
      auth: true,
      run: async (body) => {
        const raw = parse(pageSchema, body)
        return deps.capture.page(readPage(raw), raw.url)
      }
    },
    capture_update_pdf: {
      auth: true,
      run: async (body) => {
        const { key, ...raw } = parse(updatePdfSchema, body)
        return deps.capture.updatePdf(key, readPage(raw), raw.url)
      }
    },
    capture_status: {
      auth: true,
      run: async (body) => {
        const status = deps.capture.status(parse(statusSchema, body).task)
        if (!status) throw new HttpFailure(404, 'not_found')
        return status
      }
    },
    open_in_app: {
      auth: true,
      run: async (body) => {
        deps.capture.open(parse(openSchema, body).key)
        return { ok: true }
      }
    }
  }

  return async (req, res) => {
    const started = Date.now()
    const name = (req.url ?? '').slice(EXTENSION_PREFIX.length).split('?')[0]
    const endpoint = Object.hasOwn(endpoints, name) ? endpoints[name] : null
    const origin = req.headers.origin
    const done = (status: number): void => deps.onCall?.(name.slice(0, 40), status, Date.now() - started)

    if (req.method === 'GET' && name === 'ping') {
      res.writeHead(204).end()
      return
    }
    // CORS only for an extension that may make this call.
    const corsAllowed = endpoint !== null && isExtensionOrigin(origin) && (endpoint.auth ? deps.pairing.isPaired(origin) : true)
    const cors: Record<string, string> = corsAllowed ? { 'Access-Control-Allow-Origin': origin!, Vary: 'Origin' } : { Vary: 'Origin' }
    if (req.method === 'OPTIONS') {
      if (!corsAllowed) return void res.writeHead(403, { Vary: 'Origin' }).end()
      res
        .writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Max-Age': '600',
          ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {})
        })
        .end()
      return
    }
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
      done(status)
    }
    const fail = (status: number, code: string, message?: string): void => reply(status, { error: code, ...(message && message !== code ? { message } : {}) })

    if (!endpoint) return fail(404, 'not_found')
    if (req.method !== 'POST') return void res.writeHead(405, { ...cors, Allow: 'POST' }).end()
    // Only an extension's own pages call these; a web page or a local process without an extension origin is refused.
    if (!isExtensionOrigin(origin)) return fail(403, 'forbidden')
    const ext = endpoint.auth ? deps.pairing.authenticate(origin, req.headers.authorization) : null
    if (endpoint.auth && !ext) return fail(401, 'not_paired')
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return fail(415, 'invalid', 'JSON only')

    let body: unknown
    try {
      body = await readJson(req)
    } catch (error) {
      if (error instanceof HttpFailure) return fail(error.status, error.code)
      return fail(400, 'invalid', 'Malformed JSON')
    }
    try {
      reply(200, await endpoint.run(body, ext, origin))
    } catch (error) {
      if (error instanceof HttpFailure) return fail(error.status, error.code, error.message)
      if (error instanceof PairingError) return fail(PAIRING_STATUS[error.code] ?? 403, error.code)
      if (error instanceof PayloadError) return fail(error.code === 'too_large' ? 413 : 400, error.code, error.message)
      if (error instanceof CaptureFailure) return fail(CAPTURE_STATUS[error.code] ?? 400, error.code)
      if (error instanceof UserFacingError) return fail(422, error.code)
      return fail(500, 'failed')
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_EXTENSION_BODY) throw new HttpFailure(413, 'too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_EXTENSION_BODY) throw new HttpFailure(413, 'too_large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
