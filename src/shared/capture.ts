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
  /**
   * «Actualizar PDF de <clave>»: the page's PDF replaces the paper's the window is bound to («Volver a capturar desde la
   * web») or, otherwise, the one this page already is in the library. The paper comes from the main process's state.
   */
  update: 'capture:update',
  /** «Vista de lectura»: shows the reader view of the page, exactly what the reader PDF holds. */
  preview: 'capture:preview',
  /** «Ver página»: back to the page from the reader view. */
  showPage: 'capture:show-page',
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
   * `adding`: capturing and ingesting (or updating); `confirm`: the toolbar asks `question` about the paper `existing`;
   * `failed`: `error` says why (a user-facing code).
   */
  phase: 'browsing' | 'adding' | 'confirm' | 'failed'
  error: string | null
  /** The citation key of the paper the question is about (phase `confirm`). */
  existing: string | null
  /**
   * `exists`: «Agregar» found the page in the library already: update its PDF? `other_site`: the window is bound to a
   * paper but the page is on another site: update that paper's PDF anyway?
   */
  question: 'exists' | 'other_site' | null
  pdfMode: CapturePdfMode
  /** The paper this window updates («Volver a capturar desde la web»); null when it adds pages. */
  target: string | null
  /** The library paper this page already is (same URL), found while browsing; null when none (or bound to a paper). */
  known: string | null
  /** The view shown: the page, or its reader view (`loading` while it is built). */
  preview: 'off' | 'loading' | 'on'
  /** `no_article`: the reader view was asked for, but the page has no article (its PDF is the page as it looks). */
  notice: 'no_article' | null
}

/** The paper «Actualizar PDF de <clave>» writes to: the bound one, else the one the page already is; null to add. */
export const updateTarget = (state: Pick<CaptureState, 'target' | 'known'>): string | null => state.target ?? state.known

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
  update(): Promise<void>
  preview(): Promise<void>
  showPage(): Promise<void>
  onState(listener: (state: CaptureState) => void): () => void
}

/**
 * Where «Volver a capturar desde la web» starts: the paper's URL, else its DOI resolved at doi.org; null when the
 * paper has neither (or its URL is not an http(s) address).
 */
export function recaptureUrl(identifiers: { url?: string | null; doi?: string | null }): string | null {
  const url = identifiers.url?.trim()
  if (url) {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') return url
    } catch {
      // Not an address: try the DOI.
    }
  }
  const doi = identifiers.doi?.trim()
  return doi ? `https://doi.org/${encodeURI(doi)}` : null
}
