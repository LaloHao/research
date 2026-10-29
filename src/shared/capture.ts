/**
 * The app's browser window («Abrir en el navegador de la app»): the user browses a page that refuses the app's
 * downloads (bot protection, a login, a page built by scripts) and adds it from there. This module has no runtime
 * imports: the window's sandboxed preload loads it.
 */

/** Channels of the window's toolbar; the main process answers them only from that toolbar. */
export const CAPTURE_IPC = {
  add: 'capture:add',
  cancel: 'capture:cancel',
  back: 'capture:back',
  forward: 'capture:forward',
  reload: 'capture:reload',
  state: 'capture:state'
} as const

/** What the toolbar shows: the page the user is on and where the capture stands. */
export interface CaptureState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** `adding`: capturing and ingesting; `failed`: `error` says why (a user-facing code). */
  phase: 'browsing' | 'adding' | 'failed'
  error: string | null
}

/** The toolbar's API (`window.capture`), from its preload. */
export interface CaptureApi {
  add(): Promise<void>
  cancel(): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  onState(listener: (state: CaptureState) => void): () => void
}
