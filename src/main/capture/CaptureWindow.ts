import { BrowserWindow, ipcMain, session, WebContentsView, type IpcMainInvokeEvent } from 'electron'
import { CAPTURE_IPC, isCapturePdfMode, updateTarget, type CapturePdfMode, type CaptureState } from '../../shared/capture'
import { toUserFacing, UserFacingError } from '../library/UserFacingError'
import { appLog } from '../log/appLog'
import {
  CAPTURE_PARTITION,
  fromToolbar,
  guardPage,
  hardenSession,
  isWebUrl,
  onSite,
  pageWebPreferences,
  PREVIEW_PARTITION,
  previewWebPreferences,
  readCapture,
  readPageHtml,
  routeCapture,
  siteOf,
  TOOLBAR_HEIGHT,
  toolbarWindowOptions,
  type PageCapture
} from './policy'
import { loadReaderDocument, printReaderPdf, readerDocument, sessionImageFetcher } from './print'

export interface CaptureWindowDeps {
  /** The toolbar's preload script. */
  preload: string
  /** Loads the toolbar page into the window (the dev server or the built file). */
  loadToolbar: (win: BrowserWindow) => Promise<void>
  /** Adds the captured page to the open project; resolves with the paper it went to. */
  ingest: (capture: PageCapture) => Promise<{ paperId: string }>
  /** The paper is in the library: the main window shows it. */
  onAdded: (paperId: string) => void
  /** The paper of the open project that is this page already (same URL), if any. */
  findExisting: (url: string) => Promise<string | null>
  /** «Actualizar su PDF»: the paper's PDF becomes the new capture's (summaries stay, as with «Reemplazar PDF»). */
  replacePdf: (paperId: string, pdf: Uint8Array) => Promise<void>
  /** How the PDF is made, from the app's settings, and where a change is saved. */
  pdfMode: () => CapturePdfMode
  setPdfMode: (mode: CapturePdfMode) => Promise<void>
}

const idle = (url: string, pdfMode: CapturePdfMode, target: string | null): CaptureState => ({
  url,
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: true,
  phase: 'browsing',
  error: null,
  existing: null,
  question: null,
  pdfMode,
  target,
  known: null,
  preview: 'off',
  notice: null
})

/** What phase `confirm` waits on: a capture already made (`exists`), or the go-ahead to update from another site. */
type Pending = { kind: 'exists'; paperId: string; url: string; pdf: Uint8Array } | { kind: 'other_site'; paperId: string; url: string }

/**
 * «Abrir en el navegador de la app»: one window, a toolbar (back, forward, reload, the page's address and title,
 * «Vista de lectura», «Agregar a la biblioteca» or «Actualizar PDF de <clave>», «Cancelar») over a view with the page.
 * Opening another URL reuses it. Opened from a paper («Volver a capturar desde la web») the window is bound to that
 * paper: its PDF is what the toolbar updates. See ./policy for what the page may do.
 */
export class CaptureWindow {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  /** The reader view («Vista de lectura»), created the first time it is asked for; the page view stays alive below. */
  private reader: WebContentsView | null = null
  private state: CaptureState
  private pending: Pending | null = null
  /** Sites the bound paper lives on: its URL's, and where that first loaded (a DOI lands on the publisher's). */
  private sites: string[] = []
  private landed = false
  /** The page URL last looked up in the library. */
  private lookedUp = ''
  /** Bumped by every reader view build and by «Ver página»: a build that finds it changed is dropped. */
  private previewSeq = 0

  constructor(private readonly deps: CaptureWindowDeps) {
    this.state = idle('', deps.pdfMode(), null)
    const handle = (channel: string, action: () => unknown): void => {
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        // The toolbar sends no arguments; anything else, or another sender, is refused.
        if (args.length > 0 || !fromToolbar(event, this.win?.webContents ?? null)) throw new Error('Refused')
        await action()
      })
    }
    handle(CAPTURE_IPC.add, () => this.add())
    handle(CAPTURE_IPC.cancel, () => this.win?.close())
    handle(CAPTURE_IPC.back, () => this.page()?.navigationHistory.goBack())
    handle(CAPTURE_IPC.forward, () => this.page()?.navigationHistory.goForward())
    handle(CAPTURE_IPC.reload, () => this.page()?.reload())
    handle(CAPTURE_IPC.replace, () => this.replace())
    handle(CAPTURE_IPC.keep, () => this.keep())
    handle(CAPTURE_IPC.update, () => this.updatePdf(false))
    handle(CAPTURE_IPC.preview, () => this.showPreview())
    handle(CAPTURE_IPC.showPage, () => this.showPage())
    ipcMain.handle(CAPTURE_IPC.pdfMode, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // One argument, a known mode, from the toolbar only.
      if (args.length !== 1 || !isCapturePdfMode(args[0]) || !fromToolbar(event, this.win?.webContents ?? null)) throw new Error('Refused')
      await this.deps.setPdfMode(args[0])
      this.update({ ...this.state, pdfMode: args[0] })
      // The page as it looks has no reader view to show.
      if (args[0] === 'page') this.showPage()
    })
  }

  /**
   * Opens `url`; with `target` (a paper id, from the main process, never from a page) the window is bound to that
   * paper and its toolbar updates the paper's PDF instead of adding the page.
   */
  open(url: string, target: string | null = null): void {
    if (!isWebUrl(url)) throw new Error('Only http and https pages open in the app browser')
    this.pending = null
    this.sites = target ? [siteOf(url)!] : []
    this.landed = false
    this.lookedUp = ''
    this.previewSeq += 1
    if (this.win && !this.win.isDestroyed() && this.view) {
      this.showView('page')
      this.update(idle(url, this.deps.pdfMode(), target))
      void this.view.webContents.loadURL(url).catch(() => undefined)
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      return
    }
    hardenSession(session.fromPartition(CAPTURE_PARTITION), (blocked) => appLog.info('capture_download_blocked', { host: hostOf(blocked) }))
    const win = new BrowserWindow(toolbarWindowOptions(this.deps.preload))
    const view = new WebContentsView({ webPreferences: pageWebPreferences() })
    win.contentView.addChildView(view)
    win.on('resize', () => this.layout())
    // The toolbar is the app's own page: it never navigates nor opens windows.
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const page = view.webContents
    guardPage(page)
    const refresh = (): void => this.fromPage()
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      page.on(name as 'did-stop-loading', refresh)
    }
    page.on('did-navigate', () => this.firstLanding())
    // The reader view follows the page: a navigation or a reload builds it again.
    const follow = (): void => {
      if (this.state.preview !== 'off' && !page.isLoading()) void this.renderPreview()
    }
    page.on('did-stop-loading', follow)
    page.on('did-navigate-in-page', follow)
    win.on('closed', () => {
      if (!page.isDestroyed()) page.close()
      const reader = this.reader?.webContents
      if (reader && !reader.isDestroyed()) reader.close()
      if (this.win === win) {
        this.win = null
        this.view = null
        this.reader = null
      }
    })
    win.once('ready-to-show', () => win.show())
    this.win = win
    this.view = view
    this.reader = null
    this.state = idle(url, this.deps.pdfMode(), target)
    this.layout()
    void this.deps.loadToolbar(win).then(() => this.push())
    void page.loadURL(url).catch(() => undefined)
  }

  /** Closes the window (the project closed, or the app quits). */
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close()
  }

  private page(): Electron.WebContents | null {
    const page = this.view?.webContents
    return page && !page.isDestroyed() ? page : null
  }

  private layout(): void {
    if (!this.win || this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const bounds = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) }
    this.view?.setBounds(bounds)
    this.reader?.setBounds(bounds)
  }

  /** Shows the page or its reader view; the other stays alive, hidden. */
  private showView(which: 'page' | 'reader'): void {
    this.view?.setVisible(which === 'page')
    this.reader?.setVisible(which === 'reader')
  }

  /** Where a bound paper's URL first lands (after redirects: a DOI's publisher) counts as its site too. */
  private firstLanding(): void {
    const page = this.page()
    if (!page || this.landed || !this.state.target) return
    this.landed = true
    const site = siteOf(page.getURL())
    if (site && !this.sites.includes(site)) this.sites.push(site)
  }

  private fromPage(): void {
    const page = this.page()
    if (!page) return
    const url = page.getURL()
    // The question was about the page as it was: browsing elsewhere drops it.
    const left = this.state.phase === 'confirm' && this.pending !== null && url !== this.pending.url
    if (left) this.pending = null
    const moved = url !== this.state.url
    this.update({
      ...this.state,
      url,
      title: page.getTitle(),
      canGoBack: page.navigationHistory.canGoBack(),
      canGoForward: page.navigationHistory.canGoForward(),
      loading: page.isLoading(),
      known: url === this.lookedUp ? this.state.known : null,
      notice: moved ? null : this.state.notice,
      // Browsing on after a failure clears it.
      ...(this.state.phase === 'failed' || left ? { phase: 'browsing' as const, error: null, existing: null, question: null } : {})
    })
    if (!this.state.target && url !== this.lookedUp && isWebUrl(url)) this.lookUp(url)
  }

  /** Whether the page is in the library already: the toolbar says so and offers to update its PDF. */
  private lookUp(url: string): void {
    this.lookedUp = url
    const win = this.win
    void this.deps
      .findExisting(url)
      .catch(() => null)
      .then((id) => {
        if (this.win !== win || this.lookedUp !== url || this.state.target || id === this.state.known) return
        this.update({ ...this.state, known: id })
      })
  }

  private update(state: CaptureState): void {
    this.state = state
    this.push()
  }

  private push(): void {
    const toolbar = this.win?.webContents
    if (toolbar && !toolbar.isDestroyed()) toolbar.send(CAPTURE_IPC.state, this.state)
  }

  private capture(page: Electron.WebContents): Promise<PageCapture> {
    return readCapture(page, {
      mode: this.state.pdfMode,
      printReader: (html, url) => printReaderPdf(html, url, sessionImageFetcher(session.fromPartition(CAPTURE_PARTITION), url))
    })
  }

  private async add(): Promise<void> {
    const page = this.page()
    // A window bound to a paper updates it; it never adds the page.
    if (!page || this.state.target || this.state.phase === 'adding' || this.state.phase === 'confirm') return
    if (!isWebUrl(page.getURL())) {
      this.update({ ...this.state, phase: 'failed', error: 'unreadable_page' })
      return
    }
    this.update({ ...this.state, phase: 'adding', error: null })
    try {
      const capture = await this.capture(page)
      const routed = await routeCapture(capture, this.deps)
      if ('existing' in routed) {
        this.pending = { kind: 'exists', paperId: routed.existing, url: capture.url, pdf: routed.pdf }
        this.update({ ...this.state, phase: 'confirm', existing: routed.existing, question: 'exists' })
        return
      }
      this.deps.onAdded(routed.added)
      this.close()
    } catch (error) {
      this.update({ ...this.state, phase: 'failed', error: toUserFacing(error).message })
    }
  }

  /**
   * «Actualizar PDF de <clave>»: the bound paper's, or the paper this page already is. A bound window on another site
   * asks first (`confirmed` is the user's yes).
   */
  private async updatePdf(confirmed: boolean): Promise<void> {
    const page = this.page()
    const paperId = updateTarget(this.state)
    if (!page || !paperId || this.state.phase === 'adding' || this.state.phase === 'confirm') return
    const url = page.getURL()
    if (!isWebUrl(url)) {
      this.update({ ...this.state, phase: 'failed', error: 'unreadable_page' })
      return
    }
    if (this.state.target && !confirmed && !onSite(url, this.sites)) {
      this.pending = { kind: 'other_site', paperId, url }
      this.update({ ...this.state, phase: 'confirm', existing: paperId, question: 'other_site' })
      return
    }
    this.update({ ...this.state, phase: 'adding', error: null })
    try {
      const capture = await this.capture(page)
      if (!capture.pdf) throw new UserFacingError('capture_no_pdf')
      await this.deps.replacePdf(paperId, capture.pdf)
      this.deps.onAdded(paperId)
      this.close()
    } catch (error) {
      this.update({ ...this.state, phase: 'failed', error: toUserFacing(error).message })
    }
  }

  private async replace(): Promise<void> {
    const pending = this.pending
    if (!pending || this.state.phase !== 'confirm') return
    this.pending = null
    if (pending.kind === 'other_site') {
      this.state = { ...this.state, phase: 'browsing', existing: null, question: null }
      await this.updatePdf(true)
      return
    }
    this.update({ ...this.state, phase: 'adding', error: null, existing: null, question: null })
    try {
      await this.deps.replacePdf(pending.paperId, pending.pdf)
      this.deps.onAdded(pending.paperId)
      this.close()
    } catch (error) {
      this.update({ ...this.state, phase: 'failed', error: toUserFacing(error).message })
    }
  }

  private keep(): void {
    this.pending = null
    if (this.state.phase === 'confirm') this.update({ ...this.state, phase: 'browsing', existing: null, question: null })
  }

  /** «Vista de lectura»: only for the reader PDF (the page as it looks is what the page view shows already). */
  private async showPreview(): Promise<void> {
    if (this.state.pdfMode !== 'reader' || this.state.phase === 'adding' || !this.page()) return
    await this.renderPreview()
  }

  /**
   * Builds the reader view of the page as it is now (the same document the reader PDF is printed from) and shows it in
   * place of the page; a page without an article stays as it is, with a notice.
   */
  private async renderPreview(): Promise<void> {
    const page = this.page()
    const win = this.win
    if (!page || !win) return
    const seq = ++this.previewSeq
    const current = (): boolean => seq === this.previewSeq && this.win === win
    this.update({ ...this.state, preview: 'loading', notice: null })
    const url = page.getURL()
    let document: string | null = null
    try {
      const html = isWebUrl(url) ? await readPageHtml(page) : ''
      document = html ? await readerDocument(html, url, sessionImageFetcher(session.fromPartition(CAPTURE_PARTITION), url)) : null
    } catch {
      document = null
    }
    if (!current()) return
    if (document === null) {
      this.showView('page')
      this.update({ ...this.state, preview: 'off', notice: 'no_article' })
      return
    }
    const reader = this.readerView(win)
    try {
      await loadReaderDocument(reader.webContents, session.fromPartition(PREVIEW_PARTITION), document)
    } catch (error) {
      if (!current()) return
      appLog.warn('capture_preview_failed', { error })
      this.showView('page')
      this.update({ ...this.state, preview: 'off' })
      return
    }
    if (!current()) return
    this.showView('reader')
    this.update({ ...this.state, preview: 'on' })
  }

  /** «Ver página»: the page again; a reader view still being built is dropped. */
  private showPage(): void {
    this.previewSeq += 1
    this.showView('page')
    if (this.state.preview !== 'off' || this.state.notice) this.update({ ...this.state, preview: 'off', notice: null })
  }

  private readerView(win: BrowserWindow): WebContentsView {
    if (this.reader && !this.reader.webContents.isDestroyed()) return this.reader
    const reader = new WebContentsView({ webPreferences: previewWebPreferences() })
    const contents = reader.webContents
    // The document is the app's own and shows only: its links don't navigate, nothing opens a window.
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    reader.setVisible(false)
    win.contentView.addChildView(reader)
    this.reader = reader
    this.layout()
    return reader
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
