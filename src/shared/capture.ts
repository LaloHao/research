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
  /** Sets how the PDF is made (one argument, a `CapturePdfMode`). */
  pdfMode: 'capture:pdf-mode',
  /** «Actualizar su PDF» after the page turned out to be in the library already. */
  replace: 'capture:replace',
  /** «No» to that question: back to browsing, nothing written. */
  keep: 'capture:keep',
  state: 'capture:state'
} as const

/**
 * How the page's PDF is made: `reader`, a clean document from the article (title, authors, source, text, images), or
 * `page`, the live page printed as it looks, with cookie-consent overlays hidden. Remembered in the app's settings.
 */
export type CapturePdfMode = 'reader' | 'page'

export const CAPTURE_PDF_MODES: readonly CapturePdfMode[] = ['reader', 'page']

export const isCapturePdfMode = (value: unknown): value is CapturePdfMode => value === 'reader' || value === 'page'

/** What the toolbar shows: the page the user is on and where the capture stands. */
export interface CaptureState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /**
   * `adding`: capturing and ingesting; `confirm`: the page is in the library already as `existing`, and the toolbar
   * asks whether to update its PDF; `failed`: `error` says why (a user-facing code).
   */
  phase: 'browsing' | 'adding' | 'confirm' | 'failed'
  error: string | null
  /** The citation key of the paper this page already is (phase `confirm`). */
  existing: string | null
  pdfMode: CapturePdfMode
}

/** The toolbar's API (`window.capture`), from its preload. */
export interface CaptureApi {
  add(): Promise<void>
  cancel(): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  setPdfMode(mode: CapturePdfMode): Promise<void>
  replace(): Promise<void>
  keep(): Promise<void>
  onState(listener: (state: CaptureState) => void): () => void
}
