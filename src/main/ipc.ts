import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CountResult } from '../shared/relations'
import type { FormImpact } from '../shared/summary'
import type { DeletePlanResult, RestoreOutcome, TrashOutcome } from '../shared/trash'
import {
  IPC,
  type ActionResult,
  type ChatOpenResult,
  type ChatSendResult,
  type DecideResult,
  type FacetDecisionResult,
  type ImportChoice,
  type ImportResult,
  type LlmInfo,
  type MappingCreateResult,
  type MappingOpenResult,
  type ProjectInfo,
  type ProjectOpenResult,
  type RelationDecisionResult,
  type ResolveConflictResult,
  type RunBatchResult,
  type SaveResult,
  type TextResult
} from '../shared/ipc'
import type { AppController } from './AppController'
import { WindowDecisions } from './chats/windowDecisions'
import { arg, ipcArgs } from './ipcArgs'
import { toUserFacing, UserFacingError } from './library/UserFacingError'
import type { MappingService } from './mapping/MappingService'
import { RELATIONS_FILE } from './project/relationsFile'
import type { SyncService } from './sync/SyncService'

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

/** The native PDF picker of «Adjuntar PDF», also used when the user approves a chat's attach_pdf. */
async function choosePdf(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** The picker of «Importar»: an export of a database (BibTeX, RIS or CSV). */
async function chooseExport(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'BibTeX, RIS, CSV', extensions: ['bib', 'bibtex', 'ris', 'csv', 'txt'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/**
 * The export files the dialog of «Importar» returned, by the token handed to the window: the path never comes from the
 * window. A token is used once; only the latest few are kept.
 */
class ImportChoices {
  private readonly paths = new Map<string, string>()

  add(path: string): ImportChoice {
    const token = randomUUID()
    this.paths.set(token, path)
    while (this.paths.size > 8) this.paths.delete(this.paths.keys().next().value!)
    return { token, name: basename(path) }
  }

  take(token: string): string {
    const path = this.paths.get(token)
    if (path === undefined) throw new UserFacingError('import_unreadable')
    this.paths.delete(token)
    return path
  }
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
  ipcMain.handle(IPC.libraryAttachPdf, (_e, paperId: unknown, path: unknown, replace: unknown) => {
    app.requireSession().queue.enqueue({
      type: 'attach_pdf',
      paperId: arg(ipcArgs.paperId, paperId, 'id'),
      path: arg(ipcArgs.absolutePath, path, 'path'),
      replace: arg(ipcArgs.flag, replace, 'replace')
    })
  })
  ipcMain.handle(IPC.libraryChoosePdf, (): Promise<string | null> => choosePdf(getWindow()))
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
  ipcMain.handle(IPC.libraryTrash, (_e, rawIds: unknown): Promise<TrashOutcome> => {
    const ids = arg(ipcArgs.trashIds, rawIds, 'ids')
    return app.requireSession().trash(ids)
  })
  ipcMain.handle(IPC.trashList, () => app.requireSession().listTrash())
  ipcMain.handle(IPC.trashRestore, (_e, rawIds: unknown, rawMerge: unknown): Promise<RestoreOutcome> => {
    const ids = arg(ipcArgs.trashIds, rawIds, 'ids')
    const merge = arg(ipcArgs.flag, rawMerge, 'merge')
    return app.requireSession().restore(ids, { merge })
  })
  ipcMain.handle(IPC.trashDeletePlan, async (_e, rawTarget: unknown): Promise<DeletePlanResult> => {
    const target = arg(ipcArgs.trashTarget, rawTarget, 'target')
    try {
      return { ok: true, plan: await app.requireSession().deletePlan(target) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.trashDeleteForever, async (_e, rawIds: unknown): Promise<CountResult> => {
    const ids = arg(ipcArgs.trashIds, rawIds, 'ids')
    try {
      return { ok: true, count: await app.requireSession().deleteForever(ids) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })

  // Git sync of the open project: status, «Sincronizar», conflicts and first use.
  const sync = (): SyncService => app.requireSession().sync
  ipcMain.handle(IPC.syncStatus, () => sync().status())
  ipcMain.handle(IPC.syncRun, () => sync().run({ auto: false }))
  ipcMain.handle(IPC.syncConflicts, () => sync().conflicts())
  ipcMain.handle(IPC.syncDiff, (_e, rawId: unknown) => sync().diff(arg(ipcArgs.conflictId, rawId, 'id')))
  ipcMain.handle(IPC.syncResolve, (_e, rawChoices: unknown) => sync().resolve(arg(ipcArgs.conflictChoices, rawChoices, 'choices')))
  ipcMain.handle(IPC.syncAbort, () => sync().abort())
  ipcMain.handle(IPC.syncInit, (_e, rawUrl: unknown) => sync().setup(arg(ipcArgs.remoteUrl, rawUrl, 'url')))

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
  ipcMain.handle(IPC.summaryReviewQueue, (_e, rawIds: unknown) => {
    const ids = arg(ipcArgs.paperIds, rawIds, 'ids')
    const session = app.requireSession()
    return session.track(session.reviewQueue(ids))
  })
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

  // Facet suggestions by Claude, and filling the facets they add.
  ipcMain.handle(IPC.facetsList, () => {
    const session = app.requireSession()
    return session.track(session.facets.list())
  })
  ipcMain.handle(IPC.facetsPlan, () => app.requireSession().facets.plan())
  ipcMain.handle(IPC.facetsSuggest, (): Promise<ActionResult> => actionResult(() => app.requireSession().facets.request()))
  ipcMain.handle(IPC.facetsAccept, (_e, rawId: unknown, rawEdit: unknown): Promise<FacetDecisionResult> => {
    const id = arg(ipcArgs.suggestionId, rawId, 'id')
    const edit = arg(ipcArgs.suggestionEdit, rawEdit, 'edit')
    return decision(() => app.requireSession().facets.accept(id, edit))
  })
  ipcMain.handle(IPC.facetsReject, (_e, rawId: unknown): Promise<FacetDecisionResult> => {
    const id = arg(ipcArgs.suggestionId, rawId, 'id')
    return decision(() => app.requireSession().facets.reject(id))
  })
  ipcMain.handle(IPC.facetsRestore, (_e, rawId: unknown): Promise<FacetDecisionResult> => {
    const id = arg(ipcArgs.suggestionId, rawId, 'id')
    return decision(() => app.requireSession().facets.restore(id))
  })
  ipcMain.handle(IPC.facetsRevert, (_e, rawToken: unknown): Promise<ActionResult> => {
    const token = arg(ipcArgs.undoToken, rawToken, 'token')
    return actionResult(() => app.requireSession().facets.revert(token))
  })
  ipcMain.handle(IPC.facetsFillPlan, (_e, rawIds: unknown) => app.requireSession().summaries.fillPlan(arg(ipcArgs.paperIds, rawIds, 'ids')))
  ipcMain.handle(IPC.facetsFill, (_e, rawIds: unknown): RunBatchResult => {
    const ids = arg(ipcArgs.paperIds, rawIds, 'ids')
    try {
      const { batchId, count } = app.requireSession().summaries.requestFill(ids)
      return { ok: true, batchId, count }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })

  // Systematic mappings. Every call that reads files or writes is tracked, so closing the project waits for it. The
  // requests that cost money or the OpenAlex budget (searches, snowballing, suggestions, ingest) take `confirmed`, the
  // user's click on the confirmation, and are refused without it.
  const mappings = <T>(work: (service: MappingService) => Promise<T>): Promise<T> => {
    const session = app.requireSession()
    return session.track(work(session.mappings))
  }
  const failed = (error: unknown): { ok: false; error: string } => ({ ok: false, error: toUserFacing(error).code })
  const imports = new ImportChoices()
  ipcMain.handle(IPC.mappingsList, () => app.requireSession().mappings.list())
  ipcMain.handle(IPC.mappingsCreate, async (_e, rawTitle: unknown): Promise<MappingCreateResult> => {
    const title = arg(ipcArgs.mappingTitle, rawTitle, 'title')
    try {
      return { ok: true, id: await mappings((m) => m.create(title)) }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsOpen, async (_e, rawId: unknown): Promise<MappingOpenResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    try {
      return { ok: true, mapping: await mappings((m) => m.open(id)) }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsSaveProtocol, (_e, rawId: unknown, rawDraft: unknown, rawVersion: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const draft = arg(ipcArgs.protocolDraft, rawDraft, 'draft')
    const version = arg(ipcArgs.protocolVersion, rawVersion, 'version')
    return actionResult(() => mappings((m) => m.saveProtocol(id, draft, version)))
  })
  ipcMain.handle(IPC.mappingsSearch, (_e, rawId: unknown, rawReq: unknown, rawConfirmed: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const req = arg(ipcArgs.openalexSearch, rawReq, 'search')
    arg(ipcArgs.confirmed, rawConfirmed, 'confirmed')
    return actionResult(async () => app.requireSession().mappings.requestSearch(id, req))
  })
  ipcMain.handle(IPC.mappingsChooseImport, async (): Promise<ImportChoice | null> => {
    const path = await chooseExport(getWindow())
    return path === null ? null : imports.add(path)
  })
  ipcMain.handle(IPC.mappingsImport, async (_e, rawId: unknown, rawToken: unknown, rawSource: unknown): Promise<ImportResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const token = arg(ipcArgs.importToken, rawToken, 'file')
    const source = arg(ipcArgs.importSource, rawSource, 'source')
    try {
      const path = imports.take(token)
      return { ok: true, outcome: await mappings((m) => m.importFile(id, path, source)) }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsAddFromLibrary, async (_e, rawId: unknown, rawIds: unknown): Promise<ImportResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const ids = arg(ipcArgs.mappingPaperIds, rawIds, 'ids')
    try {
      return { ok: true, outcome: await mappings((m) => m.addFromLibrary(id, ids)) }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsSnowball, (_e, rawId: unknown, rawDirection: unknown, rawConfirmed: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const direction = arg(ipcArgs.snowballDirection, rawDirection, 'direction')
    arg(ipcArgs.confirmed, rawConfirmed, 'confirmed')
    return actionResult(async () => app.requireSession().mappings.requestSnowball(id, direction))
  })
  ipcMain.handle(IPC.mappingsDiscardSearch, (_e, rawId: unknown, rawSearch: unknown, rawReason: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const searchId = arg(ipcArgs.searchId, rawSearch, 'search')
    const reason = arg(ipcArgs.discardReason, rawReason, 'reason')
    return actionResult(() => mappings((m) => m.discardSearch(id, searchId, reason)))
  })
  ipcMain.handle(IPC.mappingsQueue, (_e, rawId: unknown, rawQuery: unknown) => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const query = arg(ipcArgs.queueQuery, rawQuery, 'query')
    return app.requireSession().mappings.queue(id, query)
  })
  ipcMain.handle(IPC.mappingsDecide, async (_e, rawId: unknown, rawReq: unknown): Promise<DecideResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const req = arg(ipcArgs.decideRequest, rawReq, 'request')
    try {
      return { ok: true, decisionId: await mappings((m) => m.decide(id, req)) }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsUndo, (_e, rawId: unknown, rawDecision: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const decisionId = arg(ipcArgs.decisionId, rawDecision, 'decision')
    return actionResult(() => mappings((m) => m.undo(id, decisionId)))
  })
  ipcMain.handle(IPC.mappingsResolveConflict, (_e, rawId: unknown, rawRecord: unknown, rawPhase: unknown, rawKeep: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const recordId = arg(ipcArgs.recordId, rawRecord, 'record')
    const phase = arg(ipcArgs.phase, rawPhase, 'phase')
    const keep = arg(ipcArgs.decisionId, rawKeep, 'keep')
    return actionResult(() => mappings((m) => m.resolveConflict(id, recordId, phase, keep)))
  })
  ipcMain.handle(IPC.mappingsResolveDuplicate, (_e, rawId: unknown, rawRecord: unknown, rawSame: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const recordId = arg(ipcArgs.recordId, rawRecord, 'record')
    const same = arg(ipcArgs.flag, rawSame, 'same')
    return actionResult(() => mappings((m) => m.resolveDuplicate(id, recordId, same)))
  })
  ipcMain.handle(IPC.mappingsSuggestPlan, (_e, rawId: unknown, rawPhase: unknown) => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const phase = arg(ipcArgs.phase, rawPhase, 'phase')
    return mappings((m) => m.suggestPlan(id, phase))
  })
  // «Sugerir» in the cost confirmation: the user's click after seeing the plan.
  // It sends the records the plan showed: main never asks about more than those.
  ipcMain.handle(IPC.mappingsSuggest, (_e, rawId: unknown, rawPhase: unknown, rawIds: unknown, rawConfirmed: unknown): RunBatchResult => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const phase = arg(ipcArgs.phase, rawPhase, 'phase')
    const ids = arg(ipcArgs.mappingRecordIds, rawIds, 'ids')
    arg(ipcArgs.confirmed, rawConfirmed, 'confirmed')
    try {
      const { batchId, count } = app.requireSession().mappings.requestSuggestions(id, phase, ids)
      return { ok: true, batchId, count }
    } catch (error) {
      return failed(error)
    }
  })
  ipcMain.handle(IPC.mappingsIngestPlan, (_e, rawId: unknown, rawIds: unknown) => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const ids = arg(ipcArgs.mappingRecordScope, rawIds, 'ids')
    return app.requireSession().mappings.ingestPlan(id, ids)
  })
  // «Agregar a la biblioteca» in its confirmation (how many, and the summaries' estimate when they are automatic): the
  // records the plan showed, never more.
  ipcMain.handle(IPC.mappingsIngest, (_e, rawId: unknown, rawIds: unknown, rawConfirmed: unknown): CountResult => {
    const id = arg(ipcArgs.mappingId, rawId, 'id')
    const ids = arg(ipcArgs.mappingRecordIds, rawIds, 'ids')
    arg(ipcArgs.confirmed, rawConfirmed, 'confirmed')
    return count(() => app.requireSession().mappings.requestIngest(id, ids))
  })

  // Chat over the library (read-only tools; answers stream on CHAT_STREAM_CHANNEL). Every call is tracked so closing
  // the project waits for it before the cache closes.
  const decisions = new WindowDecisions(() => choosePdf(getWindow()))
  const chats = <T>(work: (session: ReturnType<AppController['requireSession']>) => Promise<T>): Promise<T> => {
    const session = app.requireSession()
    return session.track(work(session))
  }
  ipcMain.handle(IPC.chatsList, (_e, raw: unknown) => app.requireSession().chats.list(arg(ipcArgs.chatListQuery, raw, 'query')))
  ipcMain.handle(IPC.chatsOpen, async (_e, rawId: unknown): Promise<ChatOpenResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    try {
      return { ok: true, chat: await chats((s) => s.chats.open(id)) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.chatsSend, async (_e, raw: unknown): Promise<ChatSendResult> => {
    const req = arg(ipcArgs.chatSend, raw, 'request')
    try {
      return { ok: true, chatId: await chats((s) => s.chats.send(req)) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })
  ipcMain.handle(IPC.chatsRetry, (_e, rawId: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    return actionResult(() => chats((s) => s.chats.retry(id)))
  })
  ipcMain.handle(IPC.chatsStop, (_e, rawId: unknown): void => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    app.requireSession().chats.stop(id)
  })
  ipcMain.handle(IPC.chatsRename, (_e, rawId: unknown, rawTitle: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const title = arg(ipcArgs.chatTitle, rawTitle, 'title')
    return actionResult(() => chats((s) => s.chats.rename(id, title)))
  })
  ipcMain.handle(IPC.chatsArchive, (_e, rawId: unknown, rawArchived: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const archived = arg(ipcArgs.flag, rawArchived, 'archived')
    return actionResult(() => chats((s) => s.chats.setArchived(id, archived)))
  })
  ipcMain.handle(IPC.chatsSetModel, (_e, rawId: unknown, rawModel: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const model = arg(ipcArgs.chatModel, rawModel, 'model')
    return actionResult(() => chats((s) => s.chats.setModel(id, model)))
  })
  // «Borrar»: `confirmed` is what the renderer's confirmation answered; the service deletes only when it is true.
  ipcMain.handle(IPC.chatsRemove, (_e, rawId: unknown, rawConfirmed: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const confirmed = arg(ipcArgs.flag, rawConfirmed, 'confirmed')
    return actionResult(() => chats((s) => s.chats.remove(id, confirmed)))
  })
  ipcMain.handle(IPC.chatsSaveToNotes, (_e, rawId: unknown, rawIndex: unknown, rawPaper: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const index = arg(ipcArgs.messageIndex, rawIndex, 'index')
    // Only a paper the user picked; otherwise the service uses a paper chat's own paper.
    const picked = arg(ipcArgs.notesPaper, rawPaper, 'paper')
    return actionResult(() => chats((s) => s.chats.saveToNotes(id, index, picked ?? undefined)))
  })
  ipcMain.handle(IPC.chatsBibtex, async (_e, rawId: unknown, rawIndex: unknown): Promise<TextResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const index = arg(ipcArgs.messageIndex, rawIndex, 'index')
    try {
      return { ok: true, text: await chats((s) => s.chats.citationsBibtex(id, index)) }
    } catch (error) {
      return { ok: false, error: toUserFacing(error).code }
    }
  })

  // «Acciones» / «Sincronizar con git»: turning one off also denies the waiting approvals of its tools.
  ipcMain.handle(IPC.chatsSetTools, (_e, rawId: unknown, rawTools: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const tools = arg(ipcArgs.chatTools, rawTools, 'tools')
    return actionResult(() => chats((s) => s.chats.setTools(id, tools)))
  })
  // «Aprobar» / «Rechazar»: `approve` is the user's click on the card. attach_pdf's file is picked here, in the app's
  // own dialog on its window: never a path from the model or the window. The dialog's wait is not tracked (closing the
  // project denies the approval; deciding it afterwards reports it gone).
  ipcMain.handle(IPC.chatsDecide, (_e, rawId: unknown, rawApproval: unknown, rawApprove: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const approvalId = arg(ipcArgs.approvalId, rawApproval, 'approval')
    const approve = arg(ipcArgs.approve, rawApprove, 'approve')
    // The session's service is captured before the PDF dialog may wait: if the project is closed or switched
    // meanwhile, the decision lands on the old service, which answers approval_gone, never on the new project's.
    return actionResult(() => decisions.decide(app.requireSession().chats, id, approvalId, approve))
  })
  // «Deshacer»: tracked, so closing the project waits for the undo before the cache closes.
  ipcMain.handle(IPC.chatsUndo, (_e, rawId: unknown, rawAction: unknown): Promise<ActionResult> => {
    const id = arg(ipcArgs.chatId, rawId, 'id')
    const actionId = arg(ipcArgs.actionId, rawAction, 'action')
    return actionResult(() => chats((s) => s.chats.undo(id, actionId)))
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
