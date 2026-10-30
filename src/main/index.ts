import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type IpcMainEvent, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_STREAM_CHANNEL } from '../shared/chat'
import { API_OPEN_CHAT_CHANNEL, API_OPEN_PAPER_CHANNEL, DRAFT_STREAM_CHANNEL, eventChannel, IPC } from '../shared/ipc'
import type { CloseDecision } from '../shared/sync'
import { AppController } from './AppController'
import { CaptureWindow } from './capture/CaptureWindow'
import { confirmClose, createQuitFlow, once } from './closeFlow'
import { UtilityEmbeddingRuntime } from './embeddings/UtilityEmbeddingRuntime'
import { waitForFlush } from './flush'
import { pickFolder, registerIpc } from './ipc'
import { arg, ipcArgs } from './ipcArgs'
import { appLog, consoleConfig, RotatingFileSink, StreamConsole } from './log/appLog'
import { autostartStatus, setAutostart, type LaunchInfo } from './tray/autostart'
import { closeAction, startHidden } from './tray/closeBehavior'
import { trayText } from './tray/strings'
import { runTrayAction } from './tray/trayActions'
import { TrayController, type TraySnapshot } from './tray/TrayController'
import { trayHost } from './tray/trayHost'
import type { TrayVariant } from './tray/trayModel'
import { railAction, syncIndicator } from '../shared/syncIndicator'
import type { SyncStatus } from '../shared/sync'

/**
 * Only the instance that holds the single-instance lock writes the log: a second launch that hands over to the running
 * one must not write a misleading start, nor rotate the shared files with its own size count.
 */
function startLog(): void {
  // The app log lives with the app's data (never in a project folder): <userData>/logs/main.log.
  appLog.setSink(new RotatingFileSink(join(app.getPath('userData'), 'logs')))
  // Mirrored to the terminal (`pnpm dev`): RESEARCH_LOG_LEVEL sets the level, RESEARCH_LOG_CONSOLE=0 turns it off.
  const mirror = consoleConfig(process.env, app.isPackaged)
  if (mirror) appLog.setConsole(new StreamConsole(process.stdout, process.stderr), mirror.level)
  appLog.info('app_start', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch })
  // Observes without changing what Electron does with an uncaught exception.
  process.on('uncaughtExceptionMonitor', (error, origin) => appLog.error('uncaught_exception', { origin, error }))
  // Unlike the monitor above, a listener marks the rejection as handled: intended. A promise nobody awaited must never
  // take the app down (with unsaved edits and running jobs); it is logged and printed instead.
  process.on('unhandledRejection', (reason) => {
    appLog.error('unhandled_rejection', { error: reason })
    console.error('Unhandled rejection', reason)
  })
}

let mainWindow: BrowserWindow | null = null
/** The first window was created: from then on the tray (or a second launch) may bring one back. */
let windowStarted = false
/** Something asked for the window before it existed: it shows even when the app starts hidden. */
let showRequested = false

/** The icons live in resources/ next to package.json (scripts/render-icons.sh makes the PNGs from the SVGs). */
const resource = (...parts: string[]): string => join(app.getAppPath(), 'resources', ...parts)
const APP_ICON = (): string => resource('icons', 'icon-256.png')

/** A tray image at 1x (24 px) and 2x (48 px): the desktop picks what its panel needs. */
function trayImage(variant: TrayVariant): NativeImage {
  const name = variant === 'normal' ? 'tray' : `tray-${variant}`
  const image = nativeImage.createFromPath(resource('tray', `${name}-24.png`))
  const big = nativeImage.createFromPath(resource('tray', `${name}-48.png`))
  if (!big.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: big.toPNG() })
  return image
}

// The local model lives with the app's data, never in a project folder.
const embeddings = new UtilityEmbeddingRuntime(join(app.getPath('userData'), 'models'), join(__dirname, 'embeddings.js'))

const controller = new AppController(
  join(app.getPath('userData'), 'settings.json'),
  (event) => {
    mainWindow?.webContents.send(eventChannel(event))
    if (event !== 'jobs-changed') syncSnapshot = null
    tray.refresh()
  },
  { embeddings },
  (update) => {
    // An answer may still be stopping while the window goes away.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHAT_STREAM_CHANNEL, update)
  },
  (update) => {
    // A draft may still be stopping while the window goes away.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DRAFT_STREAM_CHANNEL, update)
  },
  {
    // api.json lives with the app's data (on Linux ~/.config/research/api.json, where the Emacs package looks).
    dir: app.getPath('userData'),
    openInApp: (request) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      focusMainWindow()
      mainWindow.webContents.send(API_OPEN_PAPER_CHANNEL, request)
    },
    openChatInApp: (chatId) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      focusMainWindow()
      mainWindow.webContents.send(API_OPEN_CHAT_CHANNEL, chatId)
    }
  }
)

/** Lets the renderer save pending edits (e.g. notes still in their autosave delay) before its window goes away. */
function flushRenderer(win: BrowserWindow | null): Promise<boolean> {
  if (!win || win.isDestroyed()) return Promise.resolve(true)
  const contents = win.webContents
  return waitForFlush(
    () => contents.send(eventChannel('flush-request')),
    (ack) => {
      const listener = (event: IpcMainEvent): void => {
        if (event.sender === contents) ack()
      }
      ipcMain.on(IPC.flushDone, listener)
      return () => ipcMain.removeListener(IPC.flushDone, listener)
    }
  )
}

/** Shows «Hay cambios sin sincronizar» in the window and waits for the answer; a window that is gone or stuck counts as `close`. */
function askCloseDecision(win: BrowserWindow): Promise<CloseDecision> {
  return new Promise((resolve) => {
    const contents = win.webContents
    let answered = false
    const finish = (decision: CloseDecision): void => {
      if (answered) return
      answered = true
      ipcMain.removeListener(IPC.closeDecision, onAnswer)
      contents.removeListener('render-process-gone', onGone)
      contents.removeListener('destroyed', onGone)
      contents.removeListener('unresponsive', onGone)
      resolve(decision)
    }
    function onAnswer(event: IpcMainEvent, raw: unknown): void {
      if (event.sender !== contents) return
      try {
        finish(arg(ipcArgs.closeDecision, raw, 'decision'))
      } catch {
        finish('cancel')
      }
    }
    function onGone(): void {
      finish('close')
    }
    ipcMain.on(IPC.closeDecision, onAnswer)
    contents.on('render-process-gone', onGone)
    contents.on('destroyed', onGone)
    contents.on('unresponsive', onGone)
    try {
      contents.send(eventChannel('close-request'))
    } catch {
      finish('close')
    }
  })
}

/**
 * Saves pending edits, then asks only when the renderer answered the flush (it is alive) and the
 * project has changes not synced; true when the window may go. Shared by the window's `close` and
 * `before-quit`, which always act on the single `mainWindow`, so concurrent callers join one prompt.
 */
const confirmLeave = once((): Promise<boolean> => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!win) return Promise.resolve(true)
  return confirmClose({
    flush: () => flushRenderer(win),
    unsynced: () => controller.hasUnsyncedChanges(),
    ask: () => {
      if (win.isDestroyed()) return Promise.resolve<CloseDecision>('close')
      // A quit from the tray or Ctrl+Q while the window is hidden: the question needs the window.
      showMainWindow()
      return askCloseDecision(win)
    }
  })
})

/**
 * Drives `before-quit` (and the one `window-all-closed`'s `app.quit()` triggers): confirms leaving at
 * most once, shuts the app down, then quits — even if `shutdown()` throws, so the app can always quit.
 */
const quitFlow = createQuitFlow({
  confirmLeave,
  shutdown: () => controller.shutdown(),
  quit: () => {
    tray.destroy()
    app.quit()
  }
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'Research',
    icon: APP_ICON(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => {
    if (showRequested || !startHidden({ argv: process.argv, setting: controller.getSettings().startHidden, trayAvailable: tray.available() })) win.show()
  })
  // The tray's «Mostrar/Ocultar ventana», and failed jobs count as seen once the window is looked at.
  win.on('show', () => tray.refresh(0))
  win.on('hide', () => tray.refresh(0))
  win.on('focus', () => tray.refresh(0))
  let allowClose = false
  win.on('close', (event) => {
    // Once a pending quit's prompt was answered to leave, this fires again as part of that shutdown.
    if (allowClose || quitFlow.isLeavingConfirmed()) return
    event.preventDefault()
    // «Al cerrar la ventana, seguir en la bandeja»: the app keeps running (local API, jobs, sync) behind the tray icon.
    if (closeAction({ closeToTray: controller.getSettings().closeToTray, trayAvailable: tray.available(), quitting: quitFlow.isQuitting() }) === 'hide') {
      win.hide()
      void showTrayHint()
      return
    }
    void confirmLeave().then((ok) => {
      if (!ok || allowClose || win.isDestroyed()) return
      allowClose = true
      win.close()
    })
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The app's browser window goes with the app's window.
    capture?.close()
  })
  // External links (including mailto, e.g. from readable web content) open in the system
  // browser/mail client; dropped files must not navigate the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** Brings the window back (from the tray too); creates it if it is gone. */
function showMainWindow(): void {
  // Before the first window exists (a second launch while this one still starts): that window shows, even if hidden.
  if (!windowStarted) {
    showRequested = true
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  focusMainWindow()
}

/** A desktop notification; where there is none, the tray's tooltip carries the text for a moment. */
function notify(body: string, title = 'research'): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: APP_ICON() }).show()
    return
  }
  tray.say(body)
}

/** The first time the window goes to the tray: «research sigue en la bandeja», once (a setting remembers it). */
async function showTrayHint(): Promise<void> {
  if (controller.getSettings().trayHintShown) return
  notify(trayText('tray.notify.hint_body'), trayText('tray.notify.hint_title'))
  await controller.setSettings({ trayHintShown: true }).catch((error: unknown) => console.error('settings', error))
}

/** How the app was launched, for «Iniciar con la sesión». */
function launchInfo(): LaunchInfo {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    appImage: process.env.APPIMAGE,
    devElectron: [join(app.getAppPath(), 'node_modules', 'electron', 'dist', 'electron')].find((path) => existsSync(path)),
    configHome: process.env.XDG_CONFIG_HOME,
    home: app.getPath('home')
  }
}

/** The sync status the tray shows: read again after any change but a job's, and at most every 30 s otherwise. */
let syncSnapshot: { at: number; status: SyncStatus | 'failed' } | null = null

async function traySnapshot(): Promise<TraySnapshot> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const info = controller.projectInfo()
  const settings = controller.getSettings()
  let session = null
  try {
    session = info ? controller.requireSession() : null
  } catch {
    session = null
  }
  let sync = null
  let conflicts = 0
  let jobsActive = 0
  const failedJobIds: number[] = []
  if (session) {
    if (!syncSnapshot || Date.now() - syncSnapshot.at > 30_000) {
      syncSnapshot = { at: Date.now(), status: await session.sync.status().catch(() => 'failed' as const) }
    }
    const status = syncSnapshot.status
    sync = { indicator: syncIndicator(status, Date.now()), action: railAction(status) }
    conflicts = status === 'failed' ? 0 : status.conflicts
    for (const job of session.queue.list(200)) {
      if (job.state === 'queued' || job.state === 'running') jobsActive++
      else if (job.state === 'failed') failedJobIds.push(job.id)
    }
  }
  return {
    windowVisible: win?.isVisible() ?? false,
    looking: (win?.isVisible() ?? false) && (win?.isFocused() ?? false),
    projectRoot: info?.root ?? null,
    projectName: info?.name ?? null,
    sync,
    conflicts,
    jobsActive,
    failedJobIds,
    apiEnabled: controller.apiStatus() ? settings.apiEnabled : null
  }
}

const tray: TrayController = new TrayController({
  createTray: (image) => new Tray(image as NativeImage),
  buildMenu: (template) => Menu.buildFromTemplate(template),
  icon: trayImage,
  snapshot: traySnapshot,
  act: (id) =>
    void runTrayAction(id, {
      // Left click: hides the window in front of the user; brings it back (or to the front) otherwise.
      toggleWindow: () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
        else showMainWindow()
      },
      readClipboard: () => clipboard.readText(),
      hasProject: () => controller.projectInfo() !== null,
      addIdentifier: (input) => void controller.requireSession().queue.enqueue({ type: 'ingest_identifier', input }),
      openInAppBrowser: (url) => captureWindow().open(url),
      syncStatus: () => controller.requireSession().sync.status(),
      runSync: () => controller.requireSession().sync.run({ auto: false }),
      openSyncView: () => {
        showMainWindow()
        mainWindow?.webContents.send(eventChannel('open-sync'))
      },
      toggleApi: async () => void (await controller.setSettings({ apiEnabled: !controller.getSettings().apiEnabled })),
      openProject: async () => {
        showMainWindow()
        const root = await pickFolder(mainWindow, false)
        if (root) await controller.openProject(root).catch(() => notify(trayText('tray.notify.open_failed')))
      },
      quit: () => app.quit(),
      notify: (body) => notify(body)
    }).catch((error: unknown) => {
      console.error('tray action', id, error)
      appLog.error('tray_action_failed', { action: id, error })
    })
})

/**
 * Creates the tray icon once the desktop can show it. A session that starts the app before its panel is up (an
 * autostart) gets the icon as soon as the panel registers; until then closing the window quits, as without a tray.
 */
async function startTray(): Promise<void> {
  const attempt = async (): Promise<boolean> => {
    if ((await trayHost(process.platform)) === 'no') return false
    if (!tray.create()) appLog.warn('tray_unavailable', { reason: 'create_failed' })
    return true
  }
  if (await attempt()) return
  void (async () => {
    for (let n = 0; n < 30; n++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (await attempt()) return
    }
    appLog.warn('tray_unavailable', { reason: 'no_status_notifier_watcher' })
  })()
}

let capture: CaptureWindow | null = null

/** «Abrir en el navegador de la app»: created on first use; a captured page goes to the open project. */
function captureWindow(): { open(url: string, target?: string): void } {
  return {
    open: (url, target) => {
      capture ??= new CaptureWindow({
        preload: join(__dirname, '../preload/capture.js'),
        loadToolbar: (win) =>
          process.env.ELECTRON_RENDERER_URL ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture.html`) : win.loadFile(join(__dirname, '../renderer/capture.html')),
        ingest: (page) => controller.requireSession().ingestCapture(page),
        // The library list shows the new paper (library-changed); the app comes back to the front.
        onAdded: () => focusMainWindow(),
        findExisting: (url) => controller.requireSession().findCapturedPage(url),
        replacePdf: (paperId, pdf) => controller.requireSession().replaceCapturedPdf(paperId, pdf),
        pdfMode: () => controller.getSettings().capturePdfMode,
        setPdfMode: async (mode) => void (await controller.setSettings({ capturePdfMode: mode }))
      })
      capture.open(url, target ?? null)
    }
  }
}

/** The renderer only needs to copy to the clipboard; every other permission (camera, geolocation, …) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

function start(): void {
  startLog()
  // A second launch (also from the session's autostart or a desktop launcher) shows this one's window, even from the tray.
  app.on('second-instance', showMainWindow)

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
    registerIpc(controller, () => mainWindow, captureWindow(), {
      status: () => ({ trayAvailable: tray.available(), autostart: autostartStatus(launchInfo()) }),
      setAutostart: async (enabled) => {
        await setAutostart(launchInfo(), enabled, APP_ICON())
        return { trayAvailable: tray.available(), autostart: autostartStatus(launchInfo()) }
      }
    })
    // Before the window: whether it may start hidden depends on the tray being there (only the first check is awaited).
    await startTray()
    // Keeps «Sincronizado hace N min» current in the tooltip.
    setInterval(() => tray.refresh(), 60_000).unref()
    try {
      await controller.init()
    } catch (error) {
      console.error('startup', error)
      appLog.error('startup_failed', { error })
    } finally {
      mainWindow = createWindow()
      windowStarted = true
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // Several `before-quit` (one per Cmd+Q / File > Quit, plus the one `window-all-closed` triggers) can
  // arrive while the first is still confirming or shutting down; `quitFlow` makes sure only the one
  // that started the chain ever calls `app.quit()` again, and only once it is done.
  app.on('before-quit', (event) => {
    if (quitFlow.beforeQuit()) event.preventDefault()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// A second instance would open the same project and cache twice: hand over to the running one instead.
if (app.requestSingleInstanceLock()) start()
else app.quit()
