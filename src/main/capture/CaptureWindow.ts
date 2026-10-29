import { BrowserWindow, ipcMain, session, WebContentsView, type IpcMainInvokeEvent } from 'electron'
import { CAPTURE_IPC, isCapturePdfMode, type CapturePdfMode, type CaptureState } from '../../shared/capture'
import { toUserFacing } from '../library/UserFacingError'
import { appLog } from '../log/appLog'
import {
  CAPTURE_PARTITION,
  fromToolbar,
  guardPage,
  hardenSession,
  isWebUrl,
  pageWebPreferences,
  readCapture,
  routeCapture,
  TOOLBAR_HEIGHT,
  toolbarWindowOptions,
  type PageCapture
} from './policy'
import { printReaderPdf } from './print'

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

const idle = (url: string, pdfMode: CapturePdfMode): CaptureState => ({
  url,
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: true,
  phase: 'browsing',
  error: null,
  existing: null,
  pdfMode
})

/**
 * «Abrir en el navegador de la app»: one window, a toolbar (back, forward, reload, the page's address and title,
 * «Agregar a la biblioteca», «Cancelar») over a view with the page. Opening another URL reuses it. See ./policy for
 * what the page may do.
 */
export class CaptureWindow {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private state: CaptureState
  /** The capture waiting for «Actualizar su PDF» (phase `confirm`). */
  private pending: { paperId: string; url: string; pdf: Uint8Array } | null = null

  constructor(private readonly deps: CaptureWindowDeps) {
    this.state = idle('', deps.pdfMode())
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
    ipcMain.handle(CAPTURE_IPC.pdfMode, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // One argument, a known mode, from the toolbar only.
      if (args.length !== 1 || !isCapturePdfMode(args[0]) || !fromToolbar(event, this.win?.webContents ?? null)) throw new Error('Refused')
      await this.deps.setPdfMode(args[0])
      this.update({ ...this.state, pdfMode: args[0] })
    })
  }

  open(url: string): void {
    if (!isWebUrl(url)) throw new Error('Only http and https pages open in the app browser')
    if (this.win && !this.win.isDestroyed() && this.view) {
      this.pending = null
      this.update(idle(url, this.deps.pdfMode()))
      void this.view.webContents.loadURL(url).catch(() => undefined)
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      return
    }
    hardenSession(session.fromPartition(CAPTURE_PARTITION), (blocked) => appLog.info('capture_download_blocked', { host: hostOf(blocked) }))
    const win = new BrowserWindow(toolbarWindowOptions(this.deps.preload))
    const view = new WebContentsView({ webPreferences: pageWebPreferences() })
    win.contentView.addChildView(view)
    const layout = (): void => {
      const [width, height] = win.getContentSize()
      view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) })
    }
    layout()
    win.on('resize', layout)
    // The toolbar is the app's own page: it never navigates nor opens windows.
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const page = view.webContents
    guardPage(page)
    const refresh = (): void => this.fromPage()
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      page.on(name as 'did-stop-loading', refresh)
    }
    win.on('closed', () => {
      if (!page.isDestroyed()) page.close()
      if (this.win === win) {
        this.win = null
        this.view = null
      }
    })
    win.once('ready-to-show', () => win.show())
    this.win = win
    this.view = view
    this.state = idle(url, this.deps.pdfMode())
    this.pending = null
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

  private fromPage(): void {
    const page = this.page()
    if (!page) return
    // The question was about the page as it was captured: browsing elsewhere drops it.
    const left = this.state.phase === 'confirm' && this.pending !== null && page.getURL() !== this.pending.url
    if (left) this.pending = null
    this.update({
      ...this.state,
      url: page.getURL(),
      title: page.getTitle(),
      canGoBack: page.navigationHistory.canGoBack(),
      canGoForward: page.navigationHistory.canGoForward(),
      loading: page.isLoading(),
      // Browsing on after a failure clears it.
      ...(this.state.phase === 'failed' || left ? { phase: 'browsing' as const, error: null, existing: null } : {})
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

  private async add(): Promise<void> {
    const page = this.page()
    if (!page || this.state.phase === 'adding' || this.state.phase === 'confirm') return
    if (!isWebUrl(page.getURL())) {
      this.update({ ...this.state, phase: 'failed', error: 'unreadable_page' })
      return
    }
    this.update({ ...this.state, phase: 'adding', error: null })
    try {
      const capture = await readCapture(page, {
        mode: this.state.pdfMode,
        printReader: (html, url) => printReaderPdf(html, url, session.fromPartition(CAPTURE_PARTITION))
      })
      const routed = await routeCapture(capture, this.deps)
      if ('existing' in routed) {
        this.pending = { paperId: routed.existing, url: capture.url, pdf: routed.pdf }
        this.update({ ...this.state, phase: 'confirm', existing: routed.existing })
        return
      }
      this.deps.onAdded(routed.added)
      this.close()
    } catch (error) {
      this.update({ ...this.state, phase: 'failed', error: toUserFacing(error).message })
    }
  }

  private async replace(): Promise<void> {
    const pending = this.pending
    if (!pending || this.state.phase !== 'confirm') return
    this.pending = null
    this.update({ ...this.state, phase: 'adding', error: null, existing: null })
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
    if (this.state.phase === 'confirm') this.update({ ...this.state, phase: 'browsing', existing: null })
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
