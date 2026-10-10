import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CountResult } from '../shared/relations'
import type { FormImpact } from '../shared/summary'
import {
  IPC,
  type ActionResult,
  type LlmInfo,
  type ProjectInfo,
  type ProjectOpenResult,
  type RelationDecisionResult,
  type ResolveConflictResult,
  type RunBatchResult,
  type SaveResult
} from '../shared/ipc'
import type { AppController } from './AppController'
import { arg, ipcArgs } from './ipcArgs'
import { toUserFacing } from './library/UserFacingError'
import { RELATIONS_FILE } from './project/relationsFile'

/** Writes travel back as `{ ok }`; failures carry the code the UI translates. */
async function actionResult(action: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await action()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: toUserFacing(error).code }
  }
}

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

  ipcMain.handle(IPC.summaryRun, (_e, rawId: unknown, rawOpts: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    const opts = arg(ipcArgs.runOptions, rawOpts, 'opts')
    return actionResult(() => app.requireSession().summaries.request(id, opts))
  })
  ipcMain.handle(IPC.summaryPlan, () => app.requireSession().summaries.plan())
  ipcMain.handle(IPC.summaryRunBatch, async (_e, rawOpts: unknown): Promise<RunBatchResult> => {
    const opts = arg(ipcArgs.batchOptions, rawOpts, 'opts')
    try {
      const { batchId, count } = await app.requireSession().summaries.requestBatch(opts)
      return { ok: true, batchId, count }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.summarySetStatus, (_e, rawId: unknown, rawSection: unknown, rawKey: unknown, rawStatus: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    const section = arg(ipcArgs.section, rawSection, 'section')
    const key = arg(ipcArgs.fieldKey, rawKey, 'key')
    const status = arg(ipcArgs.reviewStatus, rawStatus, 'status')
    return actionResult(() => app.requireSession().summaries.setStatus(id, section, key, status))
  })
  ipcMain.handle(IPC.summaryEdit, (_e, rawId: unknown, rawSection: unknown, rawKey: unknown, value: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    const section = arg(ipcArgs.section, rawSection, 'section')
    const key = arg(ipcArgs.fieldKey, rawKey, 'key')
    return actionResult(() => app.requireSession().summaries.edit(id, section, key, value))
  })
  ipcMain.handle(IPC.summaryVerifyAll, (_e, rawId: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    return actionResult(() => app.requireSession().summaries.verifyAll(id))
  })
  ipcMain.handle(IPC.summaryAcceptProposed, (_e, rawFacetKey: unknown, rawValue: unknown): Promise<ActionResult> => {
    const facetKey = arg(ipcArgs.fieldKey, rawFacetKey, 'facetKey')
    const value = arg(ipcArgs.fieldKey, rawValue, 'value')
    return actionResult(() => app.requireSession().summaries.acceptProposed(facetKey, value))
  })
  ipcMain.handle(IPC.summaryMapProposed, (_e, rawFacetKey: unknown, rawFrom: unknown, rawTo: unknown): Promise<ActionResult> => {
    const facetKey = arg(ipcArgs.fieldKey, rawFacetKey, 'facetKey')
    const from = arg(ipcArgs.text, rawFrom, 'from')
    const to = arg(ipcArgs.text, rawTo, 'to')
    return actionResult(() => app.requireSession().summaries.mapProposed(facetKey, from, to))
  })
  ipcMain.handle(IPC.summaryReviewQueue, (_e, rawIds: unknown) =>
    app.requireSession().summaries.reviewQueue(arg(ipcArgs.paperIds, rawIds, 'ids'))
  )
  ipcMain.handle(IPC.summaryPageText, (_e, rawId: unknown, rawPage: unknown) => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    const page = arg(ipcArgs.pageNumber, rawPage, 'page')
    return app.requireSession().summaries.pageText(id, page)
  })

  ipcMain.handle(IPC.llmInfo, async (): Promise<LlmInfo> => {
    const session = app.requireSession()
    return {
      config: session.store.config.llm,
      monthSpentUsd: await session.summaries.monthSpent(),
      estimatePerPaperUsd: session.summaries.estimate(),
      form: session.summaries.formInfo()
    }
  })
  ipcMain.handle(IPC.llmUpdate, (_e, rawPatch: unknown): Promise<ActionResult> => {
    const patch = arg(ipcArgs.llmPatch, rawPatch, 'patch')
    return actionResult(async () => {
      await app.requireSession().summaries.updateLlm(patch)
      app.notifyProjectChanged()
    })
  })
  ipcMain.handle(IPC.llmCreateForm, (): Promise<ActionResult> => actionResult(() => app.requireSession().summaries.ensureForm()))
  ipcMain.handle(IPC.llmFormImpact, (_e, rawForm: unknown): Promise<FormImpact> => {
    const form = arg(ipcArgs.extractionForm, rawForm, 'form')
    return app.requireSession().summaries.formImpact(form)
  })
  ipcMain.handle(IPC.llmUpdateForm, (_e, rawForm: unknown): Promise<ActionResult> => {
    const form = arg(ipcArgs.extractionForm, rawForm, 'form')
    return actionResult(async () => {
      await app.requireSession().summaries.updateForm(form)
      app.notifyProjectChanged()
    })
  })
  ipcMain.handle(IPC.llmResetForm, (): Promise<ActionResult> =>
    actionResult(async () => {
      await app.requireSession().summaries.resetForm()
      app.notifyProjectChanged()
    })
  )
  ipcMain.handle(IPC.llmShowProjectFile, () => {
    shell.showItemInFolder(join(app.requireSession().store.root, 'project.yaml'))
  })

  ipcMain.handle(IPC.thesisGet, () => app.requireSession().summaries.thesis())
  ipcMain.handle(IPC.thesisUpdate, (_e, rawCtx: unknown): Promise<ActionResult> => {
    const ctx = arg(ipcArgs.thesisContext, rawCtx, 'ctx')
    return actionResult(async () => {
      await app.requireSession().summaries.updateThesis(ctx)
      app.notifyProjectChanged()
    })
  })

  const count = (action: () => number): CountResult => {
    try {
      return { ok: true, count: action() }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  }
  ipcMain.handle(IPC.citationsUpdate, (_e, rawIds: unknown): CountResult => {
    const ids = arg(ipcArgs.paperIds, rawIds, 'ids')
    return count(() => app.requireSession().citations.requestUpdate(ids))
  })
  ipcMain.handle(IPC.citationsFetchCitedBy, (): CountResult => count(() => app.requireSession().citations.requestCitedBy()))
  ipcMain.handle(IPC.citationsCandidates, (_e, rawQuery: unknown) => {
    const query = arg(ipcArgs.candidateQuery, rawQuery, 'query')
    const session = app.requireSession()
    return session.track(session.citations.candidates(query))
  })
  ipcMain.handle(IPC.citationsDismiss, (_e, rawId: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.openalexId, rawId, 'id')
    return actionResult(() => app.requireSession().citations.dismiss(id))
  })
  ipcMain.handle(IPC.citationsAdd, (_e, rawId: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.openalexId, rawId, 'id')
    return actionResult(async () => app.requireSession().citations.add(id))
  })

  ipcMain.handle(IPC.mapGraph, () => app.requireSession().map.graph())
  ipcMain.handle(IPC.mapRelations, (_e, rawId: unknown) => {
    const session = app.requireSession()
    return session.track(session.map.relations(arg(ipcArgs.paperId, rawId, 'id')))
  })
  ipcMain.handle(IPC.mapFacets, () => app.requireSession().map.facetOptions())
  ipcMain.handle(IPC.mapChart, (_e, rawQuery: unknown) => app.requireSession().map.chart(arg(ipcArgs.chartQuery, rawQuery, 'query')))
  ipcMain.handle(IPC.mapFacetPaperIds, (_e, rawFilters: unknown) => app.requireSession().map.facetPaperIds(arg(ipcArgs.facetFilters, rawFilters, 'filters')))

  ipcMain.handle(IPC.modelsInfo, () => app.modelInfo())
  ipcMain.handle(IPC.modelsDownload, (): Promise<ActionResult> => actionResult(() => app.requireSession().similarity.requestModelDownload()))
  ipcMain.handle(IPC.modelsRemove, (): Promise<ActionResult> => actionResult(() => app.removeModel()))

  const decision = async (action: () => Promise<string>): Promise<RelationDecisionResult> => {
    try {
      return { ok: true, undoToken: await action() }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  }
  ipcMain.handle(IPC.relationsForPaper, (_e, rawId: unknown) => app.requireSession().relations.forPaper(arg(ipcArgs.paperId, rawId, 'id')))
  ipcMain.handle(IPC.relationsSuggest, (_e, rawId: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.paperId, rawId, 'id')
    return actionResult(() => app.requireSession().relations.request(id, { force: true }))
  })
  ipcMain.handle(IPC.relationsPlan, (_e, rawIds: unknown) => app.requireSession().relations.plan(arg(ipcArgs.paperIds, rawIds, 'ids')))
  ipcMain.handle(IPC.relationsSuggestBatch, async (_e, rawIds: unknown): Promise<RunBatchResult> => {
    const ids = arg(ipcArgs.paperIds, rawIds, 'ids')
    try {
      const { batchId, count } = await app.requireSession().relations.requestBatch({ ids })
      return { ok: true, batchId, count }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.relationsSetStatus, (_e, rawId: unknown, rawStatus: unknown): Promise<RelationDecisionResult> => {
    const id = arg(ipcArgs.relationId, rawId, 'id')
    const status = arg(ipcArgs.relationStatus, rawStatus, 'status')
    return decision(() => app.requireSession().relations.setStatus(id, status))
  })
  ipcMain.handle(IPC.relationsChangeType, (_e, rawId: unknown, rawType: unknown): Promise<RelationDecisionResult> => {
    const id = arg(ipcArgs.relationId, rawId, 'id')
    const type = arg(ipcArgs.relationType, rawType, 'type')
    return decision(() => app.requireSession().relations.changeType(id, type))
  })
  ipcMain.handle(IPC.relationsReverse, (_e, rawId: unknown): Promise<RelationDecisionResult> => {
    const id = arg(ipcArgs.relationId, rawId, 'id')
    return decision(() => app.requireSession().relations.reverse(id))
  })
  ipcMain.handle(IPC.relationsEditJustification, (_e, rawId: unknown, rawText: unknown): Promise<RelationDecisionResult> => {
    const id = arg(ipcArgs.relationId, rawId, 'id')
    const text = arg(ipcArgs.justification, rawText, 'text')
    return decision(() => app.requireSession().relations.editJustification(id, text))
  })
  ipcMain.handle(IPC.relationsRevert, (_e, rawToken: unknown): Promise<ActionResult> => {
    const token = arg(ipcArgs.undoToken, rawToken, 'token')
    return actionResult(() => app.requireSession().relations.revert(token))
  })
  ipcMain.handle(IPC.relationsFileState, () => app.requireSession().relations.fileState())
  ipcMain.handle(IPC.relationsResolveConflict, async (): Promise<ResolveConflictResult> => {
    try {
      const { dropped } = await app.requireSession().relations.resolveConflict()
      return { ok: true, dropped }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.relationsShowFile, () => {
    const root = app.requireSession().store.root
    const file = join(root, RELATIONS_FILE)
    shell.showItemInFolder(existsSync(file) ? file : root)
  })

  // A file the user chose to save (a chart, the graph, CSV data), wherever they picked; never written into the project on our own.
  ipcMain.handle(IPC.exportSave, async (_e, rawName: unknown, rawData: unknown): Promise<SaveResult> => {
    const name = arg(ipcArgs.exportName, rawName, 'name')
    const data = arg(ipcArgs.exportData, rawData, 'data')
    const window = getWindow()
    const options: Electron.SaveDialogOptions = { defaultPath: name }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false }
    try {
      await writeFile(result.filePath, data)
      return { ok: true, path: result.filePath }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
}
