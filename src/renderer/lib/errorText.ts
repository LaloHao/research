import type { TFunction } from 'i18next'
import { parseUserError } from '../../shared/library'

/** A user-facing error code from the main process (with its detail, if any), or the raw message when it is not a known code. */
export function errorText(t: TFunction, message: string): string {
  const parsed = parseUserError(message)
  if (!parsed?.detail) return t(`errors.${message}`, { defaultValue: message })
  return t(`errors.${parsed.code}`, { detail: parsed.detail, defaultValue: parsed.code })
}
