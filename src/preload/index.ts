import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { eventChannel, IPC, type ResearchApi } from '../shared/ipc'

const api: ResearchApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  project: {
    current: () => ipcRenderer.invoke(IPC.projectCurrent),
    create: (name) => ipcRenderer.invoke(IPC.projectCreate, name),
    open: () => ipcRenderer.invoke(IPC.projectOpen),
    update: (patch) => ipcRenderer.invoke(IPC.projectUpdate, patch),
    close: () => ipcRenderer.invoke(IPC.projectClose)
  },
  library: {
    list: (query) => ipcRenderer.invoke(IPC.libraryList, query),
    detail: (id) => ipcRenderer.invoke(IPC.libraryDetail, id),
    addIdentifier: (input) => ipcRenderer.invoke(IPC.libraryAddIdentifier, input),
    addPdfs: (paths) => ipcRenderer.invoke(IPC.libraryAddPdfs, paths),
    updateMetadata: (id, input) => ipcRenderer.invoke(IPC.libraryUpdateMetadata, id, input),
    readPdf: (id) => ipcRenderer.invoke(IPC.libraryReadPdf, id),
    readNotes: (id) => ipcRenderer.invoke(IPC.libraryReadNotes, id),
    writeNotes: (id, text, hash) => ipcRenderer.invoke(IPC.libraryWriteNotes, id, text, hash),
    showInFolder: (id) => ipcRenderer.invoke(IPC.libraryShowInFolder, id)
  },
  jobs: {
    list: () => ipcRenderer.invoke(IPC.jobsList),
    cancel: (id) => ipcRenderer.invoke(IPC.jobsCancel, id)
  },
  on: (event, callback) => {
    const channel = eventChannel(event)
    const handler = (): void => callback()
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  flushDone: () => ipcRenderer.send(IPC.flushDone),
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('research', api)
