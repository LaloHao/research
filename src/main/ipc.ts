import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type ProjectInfo } from '../shared/ipc'
import type { AppController } from './AppController'
import { toUserFacing } from './library/UserFacingError'

async function pickFolder(window: BrowserWindow | null, create: boolean): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory'] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function registerIpc(app: AppController, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.settingsGet, () => app.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch) => app.setSettings(patch))

  ipcMain.handle(IPC.projectCurrent, () => app.projectInfo())
  ipcMain.handle(IPC.projectCreate, async (_e, name: string): Promise<ProjectInfo | null> => {
    const root = await pickFolder(getWindow(), true)
    return root ? app.createProject(root, name) : null
  })
  ipcMain.handle(IPC.projectOpen, async (): Promise<ProjectInfo | null> => {
    const root = await pickFolder(getWindow(), false)
    return root ? app.openProject(root) : null
  })
  ipcMain.handle(IPC.projectUpdate, (_e, patch) => app.updateProject(patch))
  ipcMain.handle(IPC.projectClose, () => app.closeProject())

  ipcMain.handle(IPC.libraryList, (_e, query: string) => app.requireSession().library.list(query))
  ipcMain.handle(IPC.libraryDetail, (_e, id: string) => app.requireSession().library.detail(id))
  ipcMain.handle(IPC.libraryAddIdentifier, (_e, input: string) => {
    app.requireSession().queue.enqueue({ type: 'ingest_identifier', input })
  })
  ipcMain.handle(IPC.libraryAddPdfs, (_e, paths: string[]) => {
    const { queue } = app.requireSession()
    for (const path of paths) queue.enqueue({ type: 'ingest_pdf', path })
  })
  ipcMain.handle(IPC.libraryUpdateMetadata, (_e, paperId: string, input?: string) => {
    app.requireSession().queue.enqueue({ type: 'update_metadata', paperId, input })
  })
  ipcMain.handle(IPC.libraryReadPdf, async (_e, id: string) => {
    try {
      return { ok: true, data: await app.requireSession().library.readPdf(id) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.libraryReadNotes, (_e, id: string) => app.requireSession().library.readNotes(id))
  ipcMain.handle(IPC.libraryWriteNotes, (_e, id: string, text: string, hash: string | null) => app.requireSession().library.writeNotes(id, text, hash))
  ipcMain.handle(IPC.libraryShowInFolder, (_e, id: string) => {
    shell.showItemInFolder(join(app.requireSession().store.paperDir(id), 'paper.yaml'))
  })

  ipcMain.handle(IPC.jobsList, () => app.requireSession().queue.list())
  ipcMain.handle(IPC.jobsCancel, (_e, id: number) => app.requireSession().queue.cancel(id))
}
