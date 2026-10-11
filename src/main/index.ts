import { app, BrowserWindow, ipcMain, session, shell, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { eventChannel, IPC } from '../shared/ipc'
import type { CloseDecision } from '../shared/sync'
import { AppController } from './AppController'
import { confirmClose } from './closeFlow'
import { UtilityEmbeddingRuntime } from './embeddings/UtilityEmbeddingRuntime'
import { waitForFlush } from './flush'
import { registerIpc } from './ipc'
import { arg, ipcArgs } from './ipcArgs'

let mainWindow: BrowserWindow | null = null
let quitting = false
/** The close prompt in progress, shared by closing the window and quitting, so it is never shown twice. */
let leaving: Promise<boolean> | null = null

// The local model lives with the app's data, never in a project folder.
const embeddings = new UtilityEmbeddingRuntime(join(app.getPath('userData'), 'models'), join(__dirname, 'embeddings.js'))

const controller = new AppController(
  join(app.getPath('userData'), 'settings.json'),
  (event) => {
    mainWindow?.webContents.send(eventChannel(event))
  },
  { embeddings }
)

/** Lets the renderer save pending edits (e.g. notes still in their autosave delay) before its window goes away. */
function flushRenderer(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.resolve()
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

/** Shows «Hay cambios sin sincronizar» in the window and waits for the answer; a window that is gone counts as `close`. */
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
    contents.send(eventChannel('close-request'))
  })
}

/** Saves pending edits, then asks only when the project has changes not synced; true when the window may go. */
function confirmLeave(win: BrowserWindow): Promise<boolean> {
  leaving ??= confirmClose({
    flush: () => flushRenderer(win),
    unsynced: () => controller.hasUnsyncedChanges(),
    ask: () => (win.isDestroyed() ? Promise.resolve<CloseDecision>('close') : askCloseDecision(win))
  }).finally(() => {
    leaving = null
  })
  return leaving
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'Research',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
  let allowClose = false
  win.on('close', (event) => {
    // On quit, before-quit has already asked, flushed and closed the project.
    if (allowClose || quitting) return
    event.preventDefault()
    void confirmLeave(win).then((ok) => {
      if (!ok || win.isDestroyed()) return
      allowClose = true
      win.close()
    })
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** The renderer only needs to copy to the clipboard; every other permission (camera, geolocation, …) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

function start(): void {
  app.on('second-instance', focusMainWindow)

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
    registerIpc(controller, () => mainWindow)
    try {
      await controller.init()
    } catch (error) {
      console.error('startup', error)
    } finally {
      mainWindow = createWindow()
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    void (win ? confirmLeave(win) : Promise.resolve(true))
      .then(async (ok) => {
        if (!ok || quitting) return
        quitting = true
        await controller.shutdown()
      })
      .catch((error) => console.error('shutdown', error))
      .finally(() => {
        if (quitting) app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// A second instance would open the same project and cache twice: hand over to the running one instead.
if (app.requestSingleInstanceLock()) start()
else app.quit()
