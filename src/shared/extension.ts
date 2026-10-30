/**
 * The browser extension («Research Connector»): it adds the page open in the user's own browser to the library through
 * the local API's `/ext/v1/*` endpoints, with a token of its own (scope `capture`) obtained by pairing.
 */

/** The browsers the extension is built for. */
export const EXTENSION_BROWSERS = ['firefox', 'chrome'] as const
export type ExtensionBrowser = (typeof EXTENSION_BROWSERS)[number]

/** How long a pairing code shown in Settings stays valid. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000
/** How long the extension's pairing request waits for «Aceptar» in the window. */
export const PAIRING_CONFIRM_TIMEOUT_MS = 2 * 60_000
/** Letters and digits that can't be mistaken for one another (no 0/O, 1/I/L, 5/S, 2/Z, 8/B, U/V). */
export const PAIRING_CODE_ALPHABET = 'ACDEFGHJKMNPQRTWXY34679'
export const PAIRING_CODE_LENGTH = 8

/** The code Settings shows («Vincular extensión»), until it is used or expires. */
export interface PairingCode {
  code: string
  /** ISO time. */
  expiresAt: string
}

/** A paired extension as Settings lists it; its token is only kept as a hash. */
export interface PairedExtension {
  id: string
  browser: ExtensionBrowser
  /** moz-extension://<uuid> or chrome-extension://<id>: the only origin its token works from. */
  origin: string
  createdAt: string
  lastUsedAt: string | null
}

/** «¿Vincular la extensión de Firefox?»: what the window asks once an extension sent a valid code. */
export interface PairingRequest {
  id: string
  browser: ExtensionBrowser
  origin: string
}

/** What Settings → Aplicación → «Extensión del navegador» shows. */
export interface ExtensionStatus {
  /** The local API is listening (pairing and capture need it). */
  apiRunning: boolean
  code: PairingCode | null
  paired: PairedExtension[]
}

/** An extension origin: the scheme of one of the two browsers and an id of lowercase letters, digits and dashes. */
export const EXTENSION_ORIGIN = /^(moz-extension:\/\/[0-9a-f-]{36}|chrome-extension:\/\/[a-p]{32})$/

export function isExtensionOrigin(origin: string | undefined): origin is string {
  return typeof origin === 'string' && EXTENSION_ORIGIN.test(origin)
}

export const browserOfOrigin = (origin: string): ExtensionBrowser => (origin.startsWith('moz-extension://') ? 'firefox' : 'chrome')
