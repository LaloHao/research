import { userErrorMessage, type UserErrorCode } from '../../shared/library'
import { EmbeddingError } from '../embeddings/Embedder'
import { HttpError, isOpenAlexDailyLimit, isOpenAlexUrl } from '../ingest/http'
import { LlmError } from '../llm/LlmProvider'
import { ConflictError, ProjectError } from '../project/errors'
import { InvalidEdit } from '../summary/merge'

/**
 * An error whose `message` is a code the UI translates (`errors.<code>`), followed by `: <detail>` when the failure
 * said something the user should read as it is (e.g. why OpenAlex refused a search).
 */
export class UserFacingError extends Error {
  readonly detail: string | null

  constructor(
    readonly code: UserErrorCode,
    options?: { cause?: unknown; detail?: string | null }
  ) {
    super(userErrorMessage(code, options?.detail), options)
    this.name = 'UserFacingError'
    const message = this.message
    this.detail = message === code ? null : message.slice(code.length + 2)
  }
}

/** An OpenAlex request that carries a search string (`search=` or a `*.search*` filter), not a lookup by id. */
function isOpenAlexSearch(url: string): boolean {
  if (!isOpenAlexUrl(url)) return false
  try {
    const params = new URL(url).searchParams
    return params.has('search') || /(^|,)[a-z_.]*\.search[a-z_.]*:/.test(params.get('filter') ?? '')
  } catch {
    return false
  }
}

/** An answer from a server is never a network error: what it refused, and why when it said so. */
function fromHttp(error: HttpError): UserFacingError {
  const { status } = error
  const http = `HTTP ${status}`
  const withDetail = error.detail ? `${http}: ${error.detail}` : http
  const make = (code: UserErrorCode, detail: string | null = null): UserFacingError => new UserFacingError(code, { cause: error, detail })
  if (status === 404 || status === 410) return make('not_found')
  if (status === 400 && isOpenAlexSearch(error.url)) return make('search_query_invalid', error.detail ?? http)
  // A site behind bot protection refuses any app, whatever it asks for: only a browser gets the page.
  if (error.challenge) return make('site_blocked', http)
  if (status === 429) return make(isOpenAlexDailyLimit(error) ? 'openalex_limit' : 'rate_limited')
  if (status === 401 || status === 403) return make(isOpenAlexUrl(error.url) ? 'openalex_access_denied' : 'access_denied', withDetail)
  if (status >= 500) return make('server_error', withDetail)
  return make('request_rejected', withDetail)
}

const PDF_ERRORS = new Set(['InvalidPDFException', 'PasswordException', 'FormatError'])

export function toUserFacing(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error
  if (error instanceof InvalidEdit) return new UserFacingError('invalid_edit', { cause: error })
  if (error instanceof LlmError) return new UserFacingError(error.code, { cause: error })
  if (error instanceof EmbeddingError) return new UserFacingError('model_error', { cause: error })
  if (error instanceof HttpError) return fromHttp(error)
  if (error instanceof ConflictError) return new UserFacingError('conflict', { cause: error })
  if (error instanceof ProjectError && error.code) return new UserFacingError(error.code, { cause: error })
  // pdf.js rejects corrupt, truncated or password-protected files with these.
  if (PDF_ERRORS.has((error as Error | undefined)?.name ?? '')) return new UserFacingError('unreadable_pdf', { cause: error })
  if ((error instanceof TypeError && /fetch/i.test(error.message)) || (error as Error | undefined)?.name === 'TimeoutError') {
    return new UserFacingError('network', { cause: error })
  }
  console.error(error)
  return new UserFacingError('unknown', { cause: error })
}
