import type { TFunction } from 'i18next'

/** A user-facing error code from the main process, or the raw message when it is not a known code. */
export function errorText(t: TFunction, code: string): string {
  return t(`errors.${code}`, { defaultValue: code })
}
