import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, Session, WebContents, WebPreferences } from 'electron'

/**
 * The rules of the app's browser window, apart from Electron so they can be tested: how the window and the page are
 * set up, what the page may do, and how a capture is read from it. The page is someone else's site: it runs
 * sandboxed, without a preload or Node, in its own session (its cookies and logins stay there, away from the app's),
 * every permission is denied, and the app never automates it: the user browses, solves any check the site shows, and
 * presses «Agregar a la biblioteca».
 */

/** The page's own persistent session: a login done there sticks for that site, isolated from the app's session. */
export const CAPTURE_PARTITION = 'persist:capture'

/** Height of the toolbar strip above the page. */
export const TOOLBAR_HEIGHT = 48

/** Largest page HTML read from a capture (characters); a longer one is cut there. */
export const MAX_CAPTURE_HTML = 10 * 1024 * 1024

/** Largest printed PDF kept from a capture; a larger one is left out (the paper keeps its text). */
export const MAX_CAPTURE_PDF = 200 * 1024 * 1024

/** The isolated world the HTML is read from: the page's own scripts cannot change what it sees. */
export const CAPTURE_WORLD_ID = 1999

/** Only http and https pages are opened, followed or captured. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** The window: the toolbar is its own content (the app's code, with the toolbar preload); the page is a view below it. */
export function toolbarWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    title: 'Research',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  }
}

/** The page: no preload, no Node, sandboxed, isolated, in the capture session. The user agent stays Electron's own. */
export function pageWebPreferences(): WebPreferences {
  return {
    partition: CAPTURE_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false
  }
}

type SessionLike = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler' | 'on'>

const hardened = new WeakSet<object>()

/**
 * Denies the page every permission (camera, microphone, notifications, geolocation, clipboard, MIDI, …) and every
 * download: a file the user wants from the site they download in their own browser. Once per session.
 */
export function hardenSession(session: SessionLike, onDownloadBlocked: (url: string) => void = () => undefined): void {
  if (hardened.has(session)) return
  hardened.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event, item) => {
    event.preventDefault()
    onDownloadBlocked(item.getURL())
  })
}

type ContentsLike = Pick<WebContents, 'setWindowOpenHandler' | 'on' | 'loadURL'>

/**
 * A link that opens a new window loads in the same view instead (http/https only); navigation and redirects to
 * anything but http/https (file:, javascript:, custom schemes) are stopped, and so are <webview> tags.
 */
export function guardPage(contents: ContentsLike): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void contents.loadURL(url).catch(() => undefined)
    return { action: 'deny' }
  })
  const stopNonWeb = (event: { url?: string; preventDefault: () => void }, legacyUrl?: string): void => {
    if (!isWebUrl(event.url ?? legacyUrl ?? '')) event.preventDefault()
  }
  contents.on('will-navigate', stopNonWeb)
  contents.on('will-redirect', stopNonWeb)
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Only the toolbar of the open window may drive it: any other sender (the main window, a page) is ignored. */
export function fromToolbar(event: Pick<IpcMainInvokeEvent, 'sender'>, toolbar: WebContents | null): boolean {
  return toolbar !== null && !toolbar.isDestroyed() && event.sender === toolbar
}

export interface PageCapture {
  /** The page's final URL (after redirects and the user's browsing). */
  url: string
  /** The page's HTML as it is now: untrusted data. */
  html: string
  /** The page printed to PDF; null when it could not be printed or is too large. */
  pdf: Uint8Array | null
}

type CaptureContents = Pick<WebContents, 'getURL' | 'executeJavaScriptInIsolatedWorld' | 'printToPDF'>

/** Reads what the page shows now: its URL, its HTML (from an isolated world) and a PDF print of it. */
export async function readCapture(contents: CaptureContents): Promise<PageCapture> {
  const url = contents.getURL()
  if (!isWebUrl(url)) throw new Error('Not a web page')
  const raw: unknown = await contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD_ID, [
    { code: 'document.documentElement ? document.documentElement.outerHTML : ""' }
  ])
  const html = typeof raw === 'string' ? raw.slice(0, MAX_CAPTURE_HTML) : ''
  let pdf: Uint8Array | null = null
  try {
    const printed = await contents.printToPDF({ printBackground: true })
    if (printed.byteLength <= MAX_CAPTURE_PDF) pdf = new Uint8Array(printed)
  } catch {
    // Without a PDF the paper still gets the page's text.
  }
  return { url, html, pdf }
}
