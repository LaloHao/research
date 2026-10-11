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
    attachPdf: (id, path, replace) => ipcRenderer.invoke(IPC.libraryAttachPdf, id, path, replace),
    choosePdf: () => ipcRenderer.invoke(IPC.libraryChoosePdf),
    updateMetadata: (id, input) => ipcRenderer.invoke(IPC.libraryUpdateMetadata, id, input),
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
  exports: {
    save: (defaultName, data) => ipcRenderer.invoke(IPC.exportSave, defaultName, data)
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
