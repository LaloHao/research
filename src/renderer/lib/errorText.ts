import type { TFunction } from 'i18next'
import { parseUserError, type UserErrorCode } from '../../shared/library'
import { SEARCH_CAP } from '../../shared/mapping'

/** Fixed values some error texts name (the app's own limits), so the wording follows the code. */
const ERROR_VALUES: Partial<Record<UserErrorCode, Record<string, unknown>>> = {
  search_too_large: { max: SEARCH_CAP.max }
}

/** A user-facing error code from the main process (with its detail, if any), or the raw message when it is not a known code. */
export function errorText(t: TFunction, message: string): string {
  const parsed = parseUserError(message)
  const values = parsed ? ERROR_VALUES[parsed.code] : undefined
  if (!parsed?.detail) return t(`errors.${message}`, { ...values, defaultValue: message })
  return t(`errors.${parsed.code}`, { ...values, detail: parsed.detail, defaultValue: parsed.code })
}
