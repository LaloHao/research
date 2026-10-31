/**
 * How the app makes the PDF of a plain web article sent from the browser: «Vista de lectura» (recommended: the
 * article, clean, as the app's reader view) or «Página tal como se ve» (the page with its own styles, fonts and
 * images, as the browser shows it). Chosen in the popup and remembered in the extension's storage; the keyboard
 * shortcut uses the same choice.
 */
import type { ExtensionApi } from './browser'

export type CaptureMode = 'reader' | 'page'

export const MODE_KEY = 'captureMode'

export const MODE_LABELS: Record<CaptureMode, string> = {
  reader: 'Vista de lectura (recomendado)',
  page: 'Página tal como se ve'
}

/** A stored value as a mode: anything but «page» is the reader view. */
export const parseMode = (value: unknown): CaptureMode => (value === 'page' ? 'page' : 'reader')

export async function loadMode(storage: Pick<ExtensionApi['storage']['local'], 'get'>): Promise<CaptureMode> {
  const saved = await storage.get([MODE_KEY]).catch(() => ({}) as Record<string, unknown>)
  return parseMode(saved[MODE_KEY])
}

export async function saveMode(storage: Pick<ExtensionApi['storage']['local'], 'set'>, mode: CaptureMode): Promise<void> {
  await storage.set({ [MODE_KEY]: parseMode(mode) })
}
