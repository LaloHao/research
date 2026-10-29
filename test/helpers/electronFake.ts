import { EventEmitter } from 'node:events'

/**
 * A stand-in for the parts of Electron the app browser window uses, for `vi.mock('electron', …)`: windows, views and
 * their contents record what is done to them; nothing is rendered or loaded.
 */

export class FakeContents extends EventEmitter {
  url = ''
  title = ''
  loading = false
  destroyed = false
  /** What the page's isolated world reads as its HTML. */
  html = '<html><body></body></html>'
  loads: string[] = []
  sent: unknown[] = []
  reloads = 0
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined }

  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.title
  }
  isLoading(): boolean {
    return this.loading
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  async loadURL(url: string): Promise<void> {
    this.loads.push(url)
  }
  /** The user (or a redirect) took the page to `url`, and it finished loading. */
  navigate(url: string, title = ''): void {
    this.url = url
    this.title = title
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
  }
  reload(): void {
    this.reloads += 1
  }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]): Promise<unknown> {
    return scripts[0]?.code.includes('outerHTML') ? this.html : true
  }
  async insertCSS(): Promise<string> {
    return 'css'
  }
  async removeInsertedCSS(): Promise<void> {}
  async printToPDF(): Promise<Buffer> {
    return Buffer.from(`%PDF-1.7 ${this.url}`)
  }
  setWindowOpenHandler(): void {}
  send(_channel: string, state: unknown): void {
    this.sent.push(state)
  }
  close(): void {
    this.destroyed = true
  }
}

export class WebContentsView {
  static created: WebContentsView[] = []
  readonly webContents = new FakeContents()
  visible = true
  bounds: unknown = null
  constructor(readonly options: { webPreferences: Record<string, unknown> }) {
    WebContentsView.created.push(this)
  }
  setBounds(bounds: unknown): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
}

export class BrowserWindow extends EventEmitter {
  static created: BrowserWindow[] = []
  readonly webContents = new FakeContents()
  readonly children: WebContentsView[] = []
  readonly contentView = { addChildView: (view: WebContentsView) => void this.children.push(view) }
  destroyed = false
  constructor(readonly options: Record<string, unknown>) {
    super()
    BrowserWindow.created.push(this)
  }
  getContentSize(): [number, number] {
    return [1180, 860]
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return false
  }
  restore(): void {}
  focus(): void {}
  show(): void {}
  async loadURL(url: string): Promise<void> {
    await this.webContents.loadURL(url)
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
  destroy(): void {
    this.close()
  }
}

type Handler = (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>

export const handlers = new Map<string, Handler>()

export const ipcMain = {
  handle: (channel: string, handler: Handler) => void handlers.set(channel, handler)
}

class FakeSession extends EventEmitter {
  requestFilter: ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) | null = null
  setPermissionRequestHandler(): void {}
  setPermissionCheckHandler(): void {}
  setDevicePermissionHandler(): void {}
  webRequest = { onBeforeRequest: (filter: FakeSession['requestFilter']) => void (this.requestFilter = filter) }
  async fetch(): Promise<{ ok: false; body: null }> {
    return { ok: false, body: null }
  }
}

const sessions = new Map<string, FakeSession>()

export const session = {
  fromPartition: (name: string): FakeSession => {
    if (!sessions.has(name)) sessions.set(name, new FakeSession())
    return sessions.get(name)!
  }
}

export default { BrowserWindow, WebContentsView, ipcMain, session }
