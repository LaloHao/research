import type { UserErrorCode } from '../../shared/library'
import { HttpError } from '../ingest/http'
import { ConflictError, ProjectError } from '../project/errors'

/** An error whose `message` is a code the UI translates (`errors.<code>`). */
export class UserFacingError extends Error {
  constructor(
    readonly code: UserErrorCode,
    options?: { cause?: unknown }
  ) {
    super(code, options)
    this.name = 'UserFacingError'
  }
}

const PDF_ERRORS = new Set(['InvalidPDFException', 'PasswordException', 'FormatError'])

export function toUserFacing(error: unknown): UserFacingError {
  if (error instanceof UserFacingError) return error
  if (error instanceof HttpError) return new UserFacingError(error.status === 404 ? 'not_found' : 'network', { cause: error })
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
