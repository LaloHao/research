import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CAPTURE_IPC, type CaptureApi, type CaptureState } from '../shared/capture'

/** The toolbar of the app's browser window: its buttons and the page's state, nothing else. The page itself has no preload. */
const api: CaptureApi = {
  add: () => ipcRenderer.invoke(CAPTURE_IPC.add),
  cancel: () => ipcRenderer.invoke(CAPTURE_IPC.cancel),
  back: () => ipcRenderer.invoke(CAPTURE_IPC.back),
  forward: () => ipcRenderer.invoke(CAPTURE_IPC.forward),
  reload: () => ipcRenderer.invoke(CAPTURE_IPC.reload),
  setPdfMode: (mode) => ipcRenderer.invoke(CAPTURE_IPC.pdfMode, mode),
  replace: () => ipcRenderer.invoke(CAPTURE_IPC.replace),
  keep: () => ipcRenderer.invoke(CAPTURE_IPC.keep),
  update: () => ipcRenderer.invoke(CAPTURE_IPC.update),
  preview: () => ipcRenderer.invoke(CAPTURE_IPC.preview),
  showPage: () => ipcRenderer.invoke(CAPTURE_IPC.showPage),
  onState: (listener) => {
    const handler = (_e: IpcRendererEvent, state: CaptureState): void => listener(state)
    ipcRenderer.on(CAPTURE_IPC.state, handler)
    return () => ipcRenderer.removeListener(CAPTURE_IPC.state, handler)
  }
}

contextBridge.exposeInMainWorld('capture', api)
