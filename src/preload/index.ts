import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatStreamUpdate } from '../shared/chat'
import { API_OPEN_CHAT_CHANNEL, API_OPEN_PAPER_CHANNEL, CHAT_STREAM_CHANNEL, DRAFT_STREAM_CHANNEL, eventChannel, IPC, type ResearchApi } from '../shared/ipc'
import type { ApiOpenPaper } from '../shared/localApi'
import type { DraftStreamUpdate } from '../shared/writing/draft'

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
    attachPdf: (id, path, replace) => ipcRenderer.invoke(IPC.libraryAttachPdf, id, path, replace),
    choosePdf: () => ipcRenderer.invoke(IPC.libraryChoosePdf),
    updateMetadata: (id, input) => ipcRenderer.invoke(IPC.libraryUpdateMetadata, id, input),
    editMetadata: (id, edit) => ipcRenderer.invoke(IPC.libraryEditMetadata, id, edit),
    revertMetadata: (undoToken) => ipcRenderer.invoke(IPC.libraryRevertMetadata, undoToken),
    openInBrowser: (url) => ipcRenderer.invoke(IPC.libraryOpenInBrowser, url),
    recapture: (id) => ipcRenderer.invoke(IPC.libraryRecapture, id),
    readPdf: (id) => ipcRenderer.invoke(IPC.libraryReadPdf, id),
    readNotes: (id) => ipcRenderer.invoke(IPC.libraryReadNotes, id),
    writeNotes: (id, text, hash) => ipcRenderer.invoke(IPC.libraryWriteNotes, id, text, hash),
    showInFolder: (id) => ipcRenderer.invoke(IPC.libraryShowInFolder, id),
    trash: (ids) => ipcRenderer.invoke(IPC.libraryTrash, ids)
  },
  jobs: {
    list: () => ipcRenderer.invoke(IPC.jobsList),
    cancel: (id) => ipcRenderer.invoke(IPC.jobsCancel, id)
  },
  trash: {
    list: () => ipcRenderer.invoke(IPC.trashList),
    restore: (ids, merge) => ipcRenderer.invoke(IPC.trashRestore, ids, merge),
    deletePlan: (target) => ipcRenderer.invoke(IPC.trashDeletePlan, target),
    deleteForever: (ids) => ipcRenderer.invoke(IPC.trashDeleteForever, ids)
  },
  summary: {
    run: (id, opts) => ipcRenderer.invoke(IPC.summaryRun, id, opts),
    plan: () => ipcRenderer.invoke(IPC.summaryPlan),
    runBatch: (opts) => ipcRenderer.invoke(IPC.summaryRunBatch, opts),
    setStatus: (id, section, key, status) => ipcRenderer.invoke(IPC.summarySetStatus, id, section, key, status),
    edit: (id, section, key, value) => ipcRenderer.invoke(IPC.summaryEdit, id, section, key, value),
    verifyAll: (id) => ipcRenderer.invoke(IPC.summaryVerifyAll, id),
    acceptProposed: (facetKey, value) => ipcRenderer.invoke(IPC.summaryAcceptProposed, facetKey, value),
    mapProposed: (facetKey, from, to) => ipcRenderer.invoke(IPC.summaryMapProposed, facetKey, from, to),
    reviewQueue: (ids) => ipcRenderer.invoke(IPC.summaryReviewQueue, ids),
    pageText: (id, page) => ipcRenderer.invoke(IPC.summaryPageText, id, page)
  },
  llm: {
    info: () => ipcRenderer.invoke(IPC.llmInfo),
    update: (patch) => ipcRenderer.invoke(IPC.llmUpdate, patch),
    createForm: () => ipcRenderer.invoke(IPC.llmCreateForm),
    formImpact: (form) => ipcRenderer.invoke(IPC.llmFormImpact, form),
    updateForm: (form) => ipcRenderer.invoke(IPC.llmUpdateForm, form),
    resetForm: () => ipcRenderer.invoke(IPC.llmResetForm),
    showProjectFile: () => ipcRenderer.invoke(IPC.llmShowProjectFile)
  },
  thesis: {
    get: () => ipcRenderer.invoke(IPC.thesisGet),
    update: (ctx) => ipcRenderer.invoke(IPC.thesisUpdate, ctx)
  },
  citations: {
    update: (ids) => ipcRenderer.invoke(IPC.citationsUpdate, ids),
    fetchCitedBy: () => ipcRenderer.invoke(IPC.citationsFetchCitedBy),
    candidates: (query) => ipcRenderer.invoke(IPC.citationsCandidates, query),
    dismiss: (openalexId) => ipcRenderer.invoke(IPC.citationsDismiss, openalexId),
    add: (openalexId) => ipcRenderer.invoke(IPC.citationsAdd, openalexId)
  },
  map: {
    graph: () => ipcRenderer.invoke(IPC.mapGraph),
    relations: (id) => ipcRenderer.invoke(IPC.mapRelations, id),
    facets: () => ipcRenderer.invoke(IPC.mapFacets),
    chart: (query) => ipcRenderer.invoke(IPC.mapChart, query),
    facetPaperIds: (filters) => ipcRenderer.invoke(IPC.mapFacetPaperIds, filters)
  },
  models: {
    info: () => ipcRenderer.invoke(IPC.modelsInfo),
    download: () => ipcRenderer.invoke(IPC.modelsDownload),
    remove: () => ipcRenderer.invoke(IPC.modelsRemove)
  },
  relations: {
    forPaper: (id) => ipcRenderer.invoke(IPC.relationsForPaper, id),
    suggest: (id) => ipcRenderer.invoke(IPC.relationsSuggest, id),
    plan: (ids) => ipcRenderer.invoke(IPC.relationsPlan, ids),
    suggestBatch: (ids) => ipcRenderer.invoke(IPC.relationsSuggestBatch, ids),
    setStatus: (relationId, status) => ipcRenderer.invoke(IPC.relationsSetStatus, relationId, status),
    changeType: (relationId, type) => ipcRenderer.invoke(IPC.relationsChangeType, relationId, type),
    reverse: (relationId) => ipcRenderer.invoke(IPC.relationsReverse, relationId),
    editJustification: (relationId, text) => ipcRenderer.invoke(IPC.relationsEditJustification, relationId, text),
    revert: (undoToken) => ipcRenderer.invoke(IPC.relationsRevert, undoToken),
    fileState: () => ipcRenderer.invoke(IPC.relationsFileState),
    resolveConflict: () => ipcRenderer.invoke(IPC.relationsResolveConflict),
    showFile: () => ipcRenderer.invoke(IPC.relationsShowFile)
  },
  facets: {
    list: () => ipcRenderer.invoke(IPC.facetsList),
    plan: () => ipcRenderer.invoke(IPC.facetsPlan),
    suggest: () => ipcRenderer.invoke(IPC.facetsSuggest),
    accept: (id, edit) => ipcRenderer.invoke(IPC.facetsAccept, id, edit),
    reject: (id) => ipcRenderer.invoke(IPC.facetsReject, id),
    restore: (id) => ipcRenderer.invoke(IPC.facetsRestore, id),
    revert: (undoToken) => ipcRenderer.invoke(IPC.facetsRevert, undoToken),
    fillPlan: (ids) => ipcRenderer.invoke(IPC.facetsFillPlan, ids),
    fill: (ids) => ipcRenderer.invoke(IPC.facetsFill, ids)
  },
  chats: {
    list: (query) => ipcRenderer.invoke(IPC.chatsList, query),
    open: (id) => ipcRenderer.invoke(IPC.chatsOpen, id),
    send: (req) => ipcRenderer.invoke(IPC.chatsSend, req),
    retry: (id) => ipcRenderer.invoke(IPC.chatsRetry, id),
    stop: (id) => ipcRenderer.invoke(IPC.chatsStop, id),
    rename: (id, title) => ipcRenderer.invoke(IPC.chatsRename, id, title),
    archive: (id, archived) => ipcRenderer.invoke(IPC.chatsArchive, id, archived),
    setModel: (id, model) => ipcRenderer.invoke(IPC.chatsSetModel, id, model),
    // `confirmed` comes from the window's confirmation, never assumed here.
    remove: (id, confirmed) => ipcRenderer.invoke(IPC.chatsRemove, id, confirmed),
    saveToNotes: (id, index, paperId) => ipcRenderer.invoke(IPC.chatsSaveToNotes, id, index, paperId),
    bibtex: (id, index) => ipcRenderer.invoke(IPC.chatsBibtex, id, index),
    setTools: (id, tools) => ipcRenderer.invoke(IPC.chatsSetTools, id, tools),
    // `approve` is the user's click on the card; a PDF to attach is picked by the main process, never sent from here.
    decide: (id, approvalId, approve) => ipcRenderer.invoke(IPC.chatsDecide, id, approvalId, approve),
    undo: (id, actionId) => ipcRenderer.invoke(IPC.chatsUndo, id, actionId),
    onStream: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, update: ChatStreamUpdate): void => callback(update)
      ipcRenderer.on(CHAT_STREAM_CHANNEL, handler)
      return () => ipcRenderer.removeListener(CHAT_STREAM_CHANNEL, handler)
    }
  },
  mappings: {
    list: () => ipcRenderer.invoke(IPC.mappingsList),
    create: (title) => ipcRenderer.invoke(IPC.mappingsCreate, title),
    open: (id) => ipcRenderer.invoke(IPC.mappingsOpen, id),
    saveProtocol: (id, draft, version) => ipcRenderer.invoke(IPC.mappingsSaveProtocol, id, draft, version),
    // `confirmed` comes from the window's confirmation of a costly request, never assumed here.
    searchOpenAlex: (id, req, confirmed) => ipcRenderer.invoke(IPC.mappingsSearch, id, req, confirmed),
    countOpenAlex: (id, req) => ipcRenderer.invoke(IPC.mappingsCount, id, req),
    completeSearch: (id, searchId, confirmed) => ipcRenderer.invoke(IPC.mappingsComplete, id, searchId, confirmed),
    // The export file is picked by the main process; the window only gets its name and a token.
    chooseImportFile: () => ipcRenderer.invoke(IPC.mappingsChooseImport),
    importFile: (id, token, source) => ipcRenderer.invoke(IPC.mappingsImport, id, token, source),
    addFromLibrary: (id, paperIds) => ipcRenderer.invoke(IPC.mappingsAddFromLibrary, id, paperIds),
    snowball: (id, direction, confirmed) => ipcRenderer.invoke(IPC.mappingsSnowball, id, direction, confirmed),
    discardSearch: (id, searchId, reason) => ipcRenderer.invoke(IPC.mappingsDiscardSearch, id, searchId, reason),
    queue: (id, query) => ipcRenderer.invoke(IPC.mappingsQueue, id, query),
    decide: (id, req) => ipcRenderer.invoke(IPC.mappingsDecide, id, req),
    undo: (id, decisionId) => ipcRenderer.invoke(IPC.mappingsUndo, id, decisionId),
    resolveConflict: (id, recordId, phase, keepDecisionId) => ipcRenderer.invoke(IPC.mappingsResolveConflict, id, recordId, phase, keepDecisionId),
    resolveDuplicate: (id, recordId, otherId, same) => ipcRenderer.invoke(IPC.mappingsResolveDuplicate, id, recordId, otherId, same),
    suggestPlan: (id, phase) => ipcRenderer.invoke(IPC.mappingsSuggestPlan, id, phase),
    suggest: (id, phase, recordIds, confirmed) => ipcRenderer.invoke(IPC.mappingsSuggest, id, phase, recordIds, confirmed),
    ingestPlan: (id, recordIds) => ipcRenderer.invoke(IPC.mappingsIngestPlan, id, recordIds),
    ingest: (id, recordIds, confirmed) => ipcRenderer.invoke(IPC.mappingsIngest, id, recordIds, confirmed)
  },
  exports: {
    save: (defaultName, data) => ipcRenderer.invoke(IPC.exportSave, defaultName, data)
  },
  writing: {
    library: () => ipcRenderer.invoke(IPC.writingLibrary),
    // The file is picked by the main process; the window only gets its name and a token.
    chooseFile: () => ipcRenderer.invoke(IPC.writingChooseFile),
    bibtex: (source) => ipcRenderer.invoke(IPC.writingBibtex, source),
    outlineData: (scope) => ipcRenderer.invoke(IPC.writingOutlineData, scope),
    checkPlan: (text, format) => ipcRenderer.invoke(IPC.writingCheckPlan, text, format),
    check: (req, confirmed) => ipcRenderer.invoke(IPC.writingCheck, req, confirmed),
    checkProgress: () => ipcRenderer.invoke(IPC.writingCheckProgress),
    checkStop: () => ipcRenderer.invoke(IPC.writingCheckStop),
    plan: (kind) => ipcRenderer.invoke(IPC.writingPlan, kind),
    proposeOutline: (req, confirmed) => ipcRenderer.invoke(IPC.writingProposeOutline, req, confirmed),
    reviewStyle: (req, confirmed) => ipcRenderer.invoke(IPC.writingReviewStyle, req, confirmed)
  },
  drafts: {
    list: (query) => ipcRenderer.invoke(IPC.draftsList, query),
    open: (id) => ipcRenderer.invoke(IPC.draftsOpen, id),
    // `confirmed` comes from the window's cost confirmation, never assumed here.
    run: (input, draftId, confirmed) => ipcRenderer.invoke(IPC.draftsRun, input, draftId, confirmed),
    stop: (id) => ipcRenderer.invoke(IPC.draftsStop, id),
    edit: (id, text) => ipcRenderer.invoke(IPC.draftsEdit, id, text),
    rename: (id, title) => ipcRenderer.invoke(IPC.draftsRename, id, title),
    archive: (id, archived) => ipcRenderer.invoke(IPC.draftsArchive, id, archived),
    // `confirmed` comes from the window's confirmation, never assumed here.
    remove: (id, confirmed) => ipcRenderer.invoke(IPC.draftsRemove, id, confirmed),
    onStream: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, update: DraftStreamUpdate): void => callback(update)
      ipcRenderer.on(DRAFT_STREAM_CHANNEL, handler)
      return () => ipcRenderer.removeListener(DRAFT_STREAM_CHANNEL, handler)
    }
  },
  sync: {
    status: () => ipcRenderer.invoke(IPC.syncStatus),
    run: () => ipcRenderer.invoke(IPC.syncRun),
    conflicts: () => ipcRenderer.invoke(IPC.syncConflicts),
    diff: (id) => ipcRenderer.invoke(IPC.syncDiff, id),
    resolve: (choices) => ipcRenderer.invoke(IPC.syncResolve, choices),
    abort: () => ipcRenderer.invoke(IPC.syncAbort),
    init: (url) => ipcRenderer.invoke(IPC.syncInit, url)
  },
  app: {
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs)
  },
  localApi: {
    status: () => ipcRenderer.invoke(IPC.localApiStatus),
    copyToken: () => ipcRenderer.invoke(IPC.localApiCopyToken),
    regenerateToken: () => ipcRenderer.invoke(IPC.localApiRegenerateToken),
    onOpenPaper: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, request: ApiOpenPaper): void => callback(request)
      ipcRenderer.on(API_OPEN_PAPER_CHANNEL, handler)
      return () => ipcRenderer.removeListener(API_OPEN_PAPER_CHANNEL, handler)
    },
    onOpenChat: (callback) => {
      const handler = (_e: Electron.IpcRendererEvent, chatId: unknown): void => {
        if (typeof chatId === 'string') callback(chatId)
      }
      ipcRenderer.on(API_OPEN_CHAT_CHANNEL, handler)
      return () => ipcRenderer.removeListener(API_OPEN_CHAT_CHANNEL, handler)
    }
  },
  log: {
    rendererError: (report) => ipcRenderer.send(IPC.logRendererError, report)
  },
  on: (event, callback) => {
    const channel = eventChannel(event)
    const handler = (): void => callback()
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  flushDone: () => ipcRenderer.send(IPC.flushDone),
  closeDecision: (decision) => ipcRenderer.send(IPC.closeDecision, decision),
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('research', api)
