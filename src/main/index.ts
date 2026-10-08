import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { eventChannel } from '../shared/ipc'
import { AppController } from './AppController'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let quitting = false

const controller = new AppController(join(app.getPath('userData'), 'settings.json'), (event) => {
  mainWindow?.webContents.send(eventChannel(event))
})

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

app.whenReady().then(async () => {
  registerIpc(controller, () => mainWindow)
  await controller.init()
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void controller.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
