import { app, BrowserWindow, ipcMain, session, shell, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { eventChannel, IPC } from '../shared/ipc'
import { AppController } from './AppController'
import { waitForFlush } from './flush'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let quitting = false

const controller = new AppController(join(app.getPath('userData'), 'settings.json'), (event) => {
  mainWindow?.webContents.send(eventChannel(event))
})

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
  let flushed = false
  win.on('close', (event) => {
    // On quit, before-quit has already flushed and closed the project.
    if (flushed || quitting) return
    event.preventDefault()
    flushed = true
    void flushRenderer(win).finally(() => {
      if (!win.isDestroyed()) win.close()
    })
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // External links open in the system browser; dropped files must not navigate the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
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
    quitting = true
    void flushRenderer(mainWindow)
      .then(() => controller.shutdown())
      .catch((error) => console.error('shutdown', error))
      .finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// A second instance would open the same project and cache twice: hand over to the running one instead.
if (app.requestSingleInstanceLock()) start()
else app.quit()
