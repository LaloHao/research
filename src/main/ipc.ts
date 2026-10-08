import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type ProjectInfo, type ProjectOpenResult } from '../shared/ipc'
import type { AppController } from './AppController'
import { arg, ipcArgs } from './ipcArgs'
import { toUserFacing } from './library/UserFacingError'

async function pickFolder(window: BrowserWindow | null, create: boolean): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory'] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Project errors reach the UI as codes it can translate. */
async function projectResult(action: () => Promise<ProjectInfo | null>): Promise<ProjectOpenResult> {
  try {
    return { ok: true, project: await action() }
  } catch (error) {
    return { ok: false, error: toUserFacing(error).code }
  }
}

export function registerIpc(app: AppController, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.settingsGet, () => app.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown) => app.setSettings(arg(ipcArgs.settingsPatch, patch, 'patch')))

  ipcMain.handle(IPC.projectCurrent, () => app.projectInfo())
  ipcMain.handle(IPC.projectCreate, async (_e, rawName: unknown): Promise<ProjectOpenResult> => {
    const name = arg(ipcArgs.projectName, rawName, 'name')
    const root = await pickFolder(getWindow(), true)
    return projectResult(() => (root ? app.createProject(root, name) : Promise.resolve(null)))
  })
  ipcMain.handle(IPC.projectOpen, async (): Promise<ProjectOpenResult> => {
    const root = await pickFolder(getWindow(), false)
    return projectResult(() => (root ? app.openProject(root) : Promise.resolve(null)))
  })
  ipcMain.handle(IPC.projectUpdate, (_e, patch: unknown) => app.updateProject(arg(ipcArgs.projectPatch, patch, 'patch')))
  ipcMain.handle(IPC.projectClose, () => app.closeProject())

  ipcMain.handle(IPC.libraryList, (_e, query: unknown) => app.requireSession().library.list(arg(ipcArgs.text, query, 'query')))
  ipcMain.handle(IPC.libraryDetail, (_e, id: unknown) => app.requireSession().detail(arg(ipcArgs.paperId, id, 'id')))
  ipcMain.handle(IPC.libraryAddIdentifier, (_e, input: unknown) => {
    app.requireSession().queue.enqueue({ type: 'ingest_identifier', input: arg(ipcArgs.text, input, 'input') })
  })
  ipcMain.handle(IPC.libraryAddPdfs, (_e, paths: unknown) => {
    const { queue } = app.requireSession()
    for (const path of arg(ipcArgs.paths, paths, 'paths')) queue.enqueue({ type: 'ingest_pdf', path })
  })
  ipcMain.handle(IPC.libraryUpdateMetadata, (_e, paperId: unknown, input: unknown) => {
    app.requireSession().queue.enqueue({
      type: 'update_metadata',
      paperId: arg(ipcArgs.paperId, paperId, 'id'),
      input: arg(ipcArgs.optionalText, input, 'input')
    })
  })
  ipcMain.handle(IPC.libraryReadPdf, async (_e, rawId: unknown) => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    try {
      return { ok: true, data: await app.requireSession().readPdf(id) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.libraryReadNotes, (_e, id: unknown) => app.requireSession().library.readNotes(arg(ipcArgs.paperId, id, 'id')))
  ipcMain.handle(IPC.libraryWriteNotes, (_e, id: unknown, text: unknown, hash: unknown) =>
    app.requireSession().library.writeNotes(arg(ipcArgs.paperId, id, 'id'), arg(ipcArgs.text, text, 'text'), arg(ipcArgs.hash, hash, 'hash'))
  )
  ipcMain.handle(IPC.libraryShowInFolder, (_e, id: unknown) => {
    shell.showItemInFolder(join(app.requireSession().store.paperDir(arg(ipcArgs.paperId, id, 'id')), 'paper.yaml'))
  })

  ipcMain.handle(IPC.jobsList, () => app.requireSession().queue.list())
  ipcMain.handle(IPC.jobsCancel, (_e, id: unknown) => app.requireSession().queue.cancel(arg(ipcArgs.jobId, id, 'job')))
}
