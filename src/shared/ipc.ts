import type { ChatConversation, ChatListQuery, ChatSendRequest, ChatStreamUpdate, ChatSummary } from './chat'
import type { ChatTools } from './chatActions'
import type { FacetSuggestionList, FacetSuggestPlan, SuggestionEdit } from './facetSuggestions'
import type { JobRecord } from './jobs'
import type { PaperDetail, PaperRow, UserErrorCode } from './library'
import type {
  DecideRequest,
  ImportOutcome,
  ImportSource,
  IngestPlan,
  MappingRecordRow,
  MappingSummary,
  MappingView,
  OpenAlexCount,
  OpenAlexSearchRequest,
  Phase,
  ProtocolDraft,
  QueueQuery,
  ScreeningPlan,
  SnowballDirection
} from './mapping'
import type {
  CandidateList,
  CandidateQuery,
  ChartData,
  ChartQuery,
  CountResult,
  FacetFilter,
  FacetOption,
  GraphData,
  ModelInfo,
  RelationsDetail
} from './relations'
import type { ApiOpenPaper, LocalApiStatus } from './localApi'
import type { PdfPolicy } from './schemas'
import type { AppSettings } from './settings'
import type { ExtractionForm, FormImpact, FormInfo, LlmConfig, LlmModel, ReviewItem, Section, SummaryPlan, ThesisContext } from './summary'
import type { CloseDecision, ConflictDecision, ConflictDiff, ConflictItem, SyncResult, SyncStatus } from './sync'
import type { DeletePlanResult, RestoreOutcome, TrashEntry, TrashOutcome, TrashTarget } from './trash'
import type { PaperRelations, RelationPlan, RelationsFileState, RelationStatus, RelationType } from './typedRelations'
import type { ChapterBibResult, OutlineDataResult, OutlineScope, WritingLibrary, WritingSource } from './writing/api'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  projectCurrent: 'project:current',
  projectCreate: 'project:create',
  projectOpen: 'project:open',
  projectUpdate: 'project:update',
  projectClose: 'project:close',
  libraryList: 'library:list',
  libraryDetail: 'library:detail',
  libraryAddIdentifier: 'library:add-identifier',
  libraryAddPdfs: 'library:add-pdfs',
  libraryAttachPdf: 'library:attach-pdf',
  libraryChoosePdf: 'library:choose-pdf',
  libraryUpdateMetadata: 'library:update-metadata',
  libraryReadPdf: 'library:read-pdf',
  libraryReadNotes: 'library:read-notes',
  libraryWriteNotes: 'library:write-notes',
  libraryShowInFolder: 'library:show-in-folder',
  libraryTrash: 'library:trash',
  trashList: 'trash:list',
  trashRestore: 'trash:restore',
  trashDeletePlan: 'trash:delete-plan',
  trashDeleteForever: 'trash:delete-forever',
  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',
  summaryRun: 'summary:run',
  summaryPlan: 'summary:plan',
  summaryRunBatch: 'summary:run-batch',
  summarySetStatus: 'summary:set-status',
  summaryEdit: 'summary:edit',
  summaryVerifyAll: 'summary:verify-all',
  summaryAcceptProposed: 'summary:accept-proposed',
  summaryMapProposed: 'summary:map-proposed',
  summaryReviewQueue: 'summary:review-queue',
  summaryPageText: 'summary:page-text',
  llmInfo: 'llm:info',
  llmUpdate: 'llm:update',
  llmCreateForm: 'llm:create-form',
  llmFormImpact: 'llm:form-impact',
  llmUpdateForm: 'llm:update-form',
  llmResetForm: 'llm:reset-form',
  llmShowProjectFile: 'llm:show-project-file',
  thesisGet: 'thesis:get',
  thesisUpdate: 'thesis:update',
  citationsUpdate: 'citations:update',
  citationsFetchCitedBy: 'citations:fetch-cited-by',
  citationsCandidates: 'citations:candidates',
  citationsDismiss: 'citations:dismiss',
  citationsAdd: 'citations:add',
  mapGraph: 'map:graph',
  mapRelations: 'map:relations',
  mapFacets: 'map:facets',
  mapChart: 'map:chart',
  mapFacetPaperIds: 'map:facet-paper-ids',
  modelsInfo: 'models:info',
  modelsDownload: 'models:download',
  modelsRemove: 'models:remove',
  relationsForPaper: 'relations:for-paper',
  relationsSuggest: 'relations:suggest',
  relationsPlan: 'relations:plan',
  relationsSuggestBatch: 'relations:suggest-batch',
  relationsSetStatus: 'relations:set-status',
  relationsChangeType: 'relations:change-type',
  relationsReverse: 'relations:reverse',
  relationsEditJustification: 'relations:edit-justification',
  relationsRevert: 'relations:revert',
  relationsFileState: 'relations:file-state',
  relationsResolveConflict: 'relations:resolve-conflict',
  relationsShowFile: 'relations:show-file',
  facetsList: 'facets:list',
  facetsPlan: 'facets:plan',
  facetsSuggest: 'facets:suggest',
  facetsAccept: 'facets:accept',
  facetsReject: 'facets:reject',
  facetsRestore: 'facets:restore',
  facetsRevert: 'facets:revert',
  facetsFillPlan: 'facets:fill-plan',
  facetsFill: 'facets:fill',
  chatsList: 'chats:list',
  chatsOpen: 'chats:open',
  chatsSend: 'chats:send',
  chatsRetry: 'chats:retry',
  chatsStop: 'chats:stop',
  chatsRename: 'chats:rename',
  chatsArchive: 'chats:archive',
  chatsSetModel: 'chats:set-model',
  chatsRemove: 'chats:remove',
  chatsSaveToNotes: 'chats:save-to-notes',
  chatsBibtex: 'chats:bibtex',
  chatsSetTools: 'chats:set-tools',
  chatsDecide: 'chats:decide',
  chatsUndo: 'chats:undo',
  mappingsList: 'mappings:list',
  mappingsCreate: 'mappings:create',
  mappingsOpen: 'mappings:open',
  mappingsSaveProtocol: 'mappings:save-protocol',
  mappingsSearch: 'mappings:search',
  mappingsCount: 'mappings:count',
  mappingsComplete: 'mappings:complete',
  mappingsChooseImport: 'mappings:choose-import',
  mappingsImport: 'mappings:import',
  mappingsAddFromLibrary: 'mappings:add-from-library',
  mappingsSnowball: 'mappings:snowball',
  mappingsDiscardSearch: 'mappings:discard-search',
  mappingsQueue: 'mappings:queue',
  mappingsDecide: 'mappings:decide',
  mappingsUndo: 'mappings:undo',
  mappingsResolveConflict: 'mappings:resolve-conflict',
  mappingsResolveDuplicate: 'mappings:resolve-duplicate',
  mappingsSuggestPlan: 'mappings:suggest-plan',
  mappingsSuggest: 'mappings:suggest',
  mappingsIngestPlan: 'mappings:ingest-plan',
  mappingsIngest: 'mappings:ingest',
  exportSave: 'export:save',
  writingLibrary: 'writing:library',
  writingChooseFile: 'writing:choose-file',
  writingBibtex: 'writing:bibtex',
  writingOutlineData: 'writing:outline-data',
  syncStatus: 'sync:status',
  syncRun: 'sync:run',
  syncConflicts: 'sync:conflicts',
  syncDiff: 'sync:diff',
  syncResolve: 'sync:resolve',
  syncAbort: 'sync:abort',
  syncInit: 'sync:init',
  closeDecision: 'window:close-decision',
  flushDone: 'window:flush-done',
  appOpenLogs: 'app:open-logs',
  localApiStatus: 'local-api:status',
  localApiCopyToken: 'local-api:copy-token',
  localApiRegenerateToken: 'local-api:regenerate-token',
  logRendererError: 'log:renderer-error'
} as const

export const RENDERER_ERROR_KINDS = ['error', 'unhandledrejection', 'render'] as const

/** An error the window could not handle, for the app log (bounded and redacted by the main process). */
export interface RendererErrorReport {
  kind: (typeof RENDERER_ERROR_KINDS)[number]
  message: string
  stack: string | null
  /** The script and line, for an `error` event. */
  source: string | null
}

/**
 * `sync-changed`: the git sync's state changed. `facets-changed`: the facet suggestions changed (a run, a decision,
 * or facet-suggestions.yaml edited outside the app). `chats-changed`: a conversation was written, deleted or changed
 * outside the app (answers stream on CHAT_STREAM_CHANNEL instead). `mappings-changed`: a mapping was written, or changed outside
 * the app. `flush-request`: the window is about to close; save
 * pending edits, then call `flushDone()`. `close-request`: there are changes not synced; ask, then answer with `closeDecision()`.
 */
export type ResearchEvent =
  | 'library-changed'
  | 'jobs-changed'
  | 'project-changed'
  | 'sync-changed'
  | 'facets-changed'
  | 'chats-changed'
  | 'mappings-changed'
  | 'flush-request'
  | 'close-request'

export const eventChannel = (event: ResearchEvent): string => `event:${event}`

/** The push channel of the local API's `open_in_app` (`ApiOpenPaper`): show a paper at a page. */
export const API_OPEN_PAPER_CHANNEL = 'local-api:open-paper'

/** The push channel of `ChatStreamUpdate`s (an answer as it streams). */
export const CHAT_STREAM_CHANNEL = 'chat:stream'

export interface ProjectInfo {
  root: string
  name: string
  contentLanguage: string
  pdfPolicy: PdfPolicy
}

export type NotesWriteResult = { ok: true; hash: string } | { ok: false; reason: 'conflict' }
export type ProjectOpenResult = { ok: true; project: ProjectInfo | null } | { ok: false; error: UserErrorCode }
export type PdfReadResult = { ok: true; data: Uint8Array | null } | { ok: false; error: string }

/** Any action that only signals success or failure; errors travel as a `UserErrorCode`. */
export type ActionResult = { ok: true } | { ok: false; error: string }
export type RunBatchResult = { ok: true; batchId: string; count: number } | { ok: false; error: string }
export type MappingCreateResult = { ok: true; id: string } | { ok: false; error: string }
export type MappingOpenResult = { ok: true; mapping: MappingView } | { ok: false; error: string }
/** A file picked in the app's dialog (an export to import, a text for «BibTeX»): the window sees its name and hands back only the token. */
export interface ImportChoice {
  token: string
  name: string
}
export type ImportResult = { ok: true; outcome: ImportOutcome } | { ok: false; error: string }
/** `decisionId` is what «Deshacer» sends back. */
export type DecideResult = { ok: true; decisionId: string } | { ok: false; error: string }
export type SaveResult = { ok: true; path: string } | { ok: false; error?: string }

/** A review decision on a typed relation; `undoToken` is what "Deshacer" sends back. */
export type RelationDecisionResult = { ok: true; undoToken: string } | { ok: false; error: string }
/** "Resolver automáticamente": how many invalid entries had to be left out. */
export type ResolveConflictResult = { ok: true; dropped: number } | { ok: false; error: string }
/** A decision on a facet suggestion; `undoToken` is what «Deshacer» sends back. */
export type FacetDecisionResult = RelationDecisionResult
export type ChatOpenResult = { ok: true; chat: ChatConversation } | { ok: false; error: string }
/** The conversation's id once the message is written (a new one is created by its first message). */
export type ChatSendResult = { ok: true; chatId: string } | { ok: false; error: string }
export type TextResult = { ok: true; text: string } | { ok: false; error: string }

export interface LlmInfo {
  config: LlmConfig
  monthSpentUsd: number
  estimatePerPaperUsd: number
  form: FormInfo
}

/** Everything the renderer can do, exposed as `window.research` by the preload. */
export interface ResearchApi {
  settings: {
    get(): Promise<AppSettings>
    /** Contact email, OpenAlex API key and the automatic sync; the last project path is managed by the main process. */
    set(patch: Pick<Partial<AppSettings>, 'contactEmail' | 'openalexApiKey' | 'autoSync' | 'autoSyncMinutes' | 'apiEnabled' | 'apiPort' | 'apiAllowCostly'>): Promise<AppSettings>
  }
  project: {
    current(): Promise<ProjectInfo | null>
    /** Asks for a folder, then creates the project there. `project` is null when the user cancels. */
    create(name: string): Promise<ProjectOpenResult>
    open(): Promise<ProjectOpenResult>
    update(patch: { name?: string; contentLanguage?: string; pdfPolicy?: PdfPolicy }): Promise<ProjectInfo>
    close(): Promise<void>
  }
  library: {
    list(query: string): Promise<PaperRow[]>
    detail(id: string): Promise<PaperDetail>
    /** Queue jobs; progress arrives through 'jobs-changed'. */
    addIdentifier(input: string): Promise<void>
    addPdfs(paths: string[]): Promise<void>
    /** Queues attaching the PDF at `path` to paper `id` (replacing its PDF only when `replace` is set). */
    attachPdf(id: string, path: string, replace: boolean): Promise<void>
    /** Asks for a PDF file; null when the user cancels. */
    choosePdf(): Promise<string | null>
    updateMetadata(id: string, input?: string): Promise<void>
    readPdf(id: string): Promise<PdfReadResult>
    readNotes(id: string): Promise<{ text: string; hash: string | null }>
    writeNotes(id: string, text: string, hash: string | null): Promise<NotesWriteResult>
    showInFolder(id: string): Promise<void>
    /** «Quitar de la biblioteca»: moves the papers to the trash; `moved` is what «Deshacer» restores. */
    trash(ids: string[]): Promise<TrashOutcome>
  }
  jobs: {
    list(): Promise<JobRecord[]>
    cancel(id: number): Promise<void>
  }
  trash: {
    list(): Promise<TrashEntry[]>
    /** Without `merge`, a paper whose key is taken or that was added again comes back as a conflict and stays in the trash. */
    restore(ids: string[], merge: boolean): Promise<RestoreOutcome>
    /** What deleting these papers (or 'all': «Vaciar papelera») would remove, for the confirmation; `ids` is what it counted. */
    deletePlan(target: TrashTarget): Promise<DeletePlanResult>
    /** Deletes exactly `ids` (from deletePlan): the trash is never recomputed when the user confirms. */
    deleteForever(ids: string[]): Promise<CountResult>
  }
  summary: {
    run(id: string, opts?: { force?: boolean; model?: LlmModel }): Promise<ActionResult>
    plan(): Promise<SummaryPlan>
    runBatch(opts?: { model?: LlmModel; ids?: string[] }): Promise<RunBatchResult>
    setStatus(id: string, section: Section, key: string, status: 'verified' | 'generated'): Promise<ActionResult>
    edit(id: string, section: Section, key: string, value: unknown): Promise<ActionResult>
    verifyAll(id: string): Promise<ActionResult>
    acceptProposed(facetKey: string, value: string): Promise<ActionResult>
    mapProposed(facetKey: string, from: string, to: string): Promise<ActionResult>
    /** Summary entries and suggested typed relations still to review, paper by paper. */
    reviewQueue(ids?: string[]): Promise<ReviewItem[]>
    pageText(id: string, page: number | null): Promise<string>
  }
  llm: {
    info(): Promise<LlmInfo>
    /** The main process deep-merges `budget`, so a partial budget patch only touches the fields given. */
    update(patch: Partial<Omit<LlmConfig, 'budget'>> & { budget?: Partial<LlmConfig['budget']> }): Promise<ActionResult>
    createForm(): Promise<ActionResult>
    /** How many summaries would become stale, and which removed values are still in use, if `form` were saved. */
    formImpact(form: ExtractionForm): Promise<FormImpact>
    updateForm(form: ExtractionForm): Promise<ActionResult>
    resetForm(): Promise<ActionResult>
    showProjectFile(): Promise<void>
  }
  thesis: {
    get(): Promise<ThesisContext>
    update(ctx: ThesisContext): Promise<ActionResult>
  }
  citations: {
    /** Queues citation jobs for these papers, or for all of them. */
    update(ids?: string[]): Promise<CountResult>
    /** "Buscar quién cita a mis papers": one cited_by job per paper with an OpenAlex work. */
    fetchCitedBy(): Promise<CountResult>
    candidates(query: CandidateQuery): Promise<CandidateList>
    dismiss(openalexId: string): Promise<ActionResult>
    add(openalexId: string): Promise<ActionResult>
  }
  map: {
    graph(): Promise<GraphData>
    relations(id: string): Promise<RelationsDetail>
    facets(): Promise<FacetOption[]>
    chart(query: ChartQuery): Promise<ChartData>
    facetPaperIds(filters: FacetFilter[]): Promise<string[]>
  }
  models: {
    info(): Promise<ModelInfo>
    download(): Promise<ActionResult>
    remove(): Promise<ActionResult>
  }
  relations: {
    forPaper(id: string): Promise<PaperRelations>
    /** Queues a suggestion for this paper; the user asked, so it runs even if its candidates did not change. */
    suggest(id: string): Promise<ActionResult>
    /** Papers (these, or all) with candidates their last analysis did not see, with the estimated cost. */
    plan(ids?: string[]): Promise<RelationPlan>
    suggestBatch(ids?: string[]): Promise<RunBatchResult>
    setStatus(relationId: string, status: RelationStatus): Promise<RelationDecisionResult>
    changeType(relationId: string, type: RelationType): Promise<RelationDecisionResult>
    reverse(relationId: string): Promise<RelationDecisionResult>
    editJustification(relationId: string, text: string): Promise<RelationDecisionResult>
    revert(undoToken: string): Promise<ActionResult>
    fileState(): Promise<RelationsFileState>
    resolveConflict(): Promise<ResolveConflictResult>
    showFile(): Promise<void>
  }
  facets: {
    /** Every suggestion with whether it still applies, the pending count, whether a run is going and the last run. */
    list(): Promise<FacetSuggestionList>
    /** What «Sugerir facetas» would cost: estimate and the run's own cap. */
    plan(): Promise<FacetSuggestPlan>
    /** Queues «Sugerir facetas» (nothing when one is queued or running). */
    suggest(): Promise<ActionResult>
    /** «Aceptar», or «Editar y aceptar» with the user's version. */
    accept(id: string, edit?: SuggestionEdit): Promise<FacetDecisionResult>
    reject(id: string): Promise<FacetDecisionResult>
    /** A rejected suggestion back among the ones to review. */
    restore(id: string): Promise<FacetDecisionResult>
    revert(undoToken: string): Promise<ActionResult>
    /** Papers (these, or all) with an up-to-date summary and facets still unfilled, with the estimated cost. */
    fillPlan(ids?: string[]): Promise<SummaryPlan>
    fill(ids?: string[]): Promise<RunBatchResult>
  }
  chats: {
    /** Newest first, by words in the title or the messages, or by paper. */
    list(query?: ChatListQuery): Promise<ChatSummary[]>
    /** The conversation with its citations checked, and the answer being written, if any. */
    open(id: string): Promise<ChatOpenResult>
    /** Writes the message and starts the answer, which arrives through `onStream`. */
    send(req: ChatSendRequest): Promise<ChatSendResult>
    /** «Reintentar»: answers the unanswered last question. */
    retry(id: string): Promise<ActionResult>
    /** «Detener»: what arrived is saved as a stopped answer. */
    stop(id: string): Promise<void>
    rename(id: string, title: string): Promise<ActionResult>
    archive(id: string, archived: boolean): Promise<ActionResult>
    /** The model for the next answers. */
    setModel(id: string, model: LlmModel): Promise<ActionResult>
    /** «Borrar»: `confirmed` is the user's answer to the UI's question; the conversation is deleted only when true. */
    remove(id: string, confirmed: boolean): Promise<ActionResult>
    /**
     * «Guardar en notas del paper»: answer `index` at the end of a paper's notes.md. `paperId` only when the user picked
     * a paper; without it a paper chat saves to its own paper (a global chat needs a pick).
     */
    saveToNotes(id: string, index: number, paperId?: string): Promise<ActionResult>
    /** «Copiar BibTeX de las citas» of answer `index`. */
    bibtex(id: string, index: number): Promise<TextResult>
    /** The conversation's switches («Acciones», «Sincronizar con git»). */
    setTools(id: string, tools: Partial<ChatTools>): Promise<ActionResult>
    /** «Aprobar» or «Rechazar» on an approval card; approving attach_pdf first asks for the file in the app's dialog. */
    decide(id: string, approvalId: string, approve: boolean): Promise<ActionResult>
    /** «Deshacer» of an action of the conversation. */
    undo(id: string, actionId: string): Promise<ActionResult>
    /** Answers as they stream; `seq` orders them against `open()`'s `partial`. */
    onStream(callback: (update: ChatStreamUpdate) => void): () => void
  }
  mappings: {
    list(): Promise<MappingSummary[]>
    create(title: string): Promise<MappingCreateResult>
    open(id: string): Promise<MappingOpenResult>
    /** «Guardar protocolo»; `version` is the protocol version the draft was edited from. */
    saveProtocol(id: string, draft: ProtocolDraft, version: number): Promise<ActionResult>
    /** Queues the OpenAlex search after the user confirmed it; its log entry and records appear when the job ends. */
    searchOpenAlex(id: string, req: OpenAlexSearchRequest, confirmed: true): Promise<ActionResult>
    /** OpenAlex's own count of the search's results (one request, no money), asked before the confirmation. */
    countOpenAlex(id: string, req: Omit<OpenAlexSearchRequest, 'cap'>): Promise<OpenAlexCount>
    /** «Completar búsqueda»: queues the same search at the maximum cap; it replaces `searchId` once it is logged. */
    completeSearch(id: string, searchId: string, confirmed: true): Promise<ActionResult>
    /**
     * Asks for an export file (BibTeX, RIS or CSV) in the app's dialog; null when the user cancels. The path stays in
     * the main process: `importFile` names the file by the token, once.
     */
    chooseImportFile(): Promise<ImportChoice | null>
    importFile(id: string, token: string, source: ImportSource): Promise<ImportResult>
    addFromLibrary(id: string, paperIds: string[]): Promise<ImportResult>
    /** Queues a snowballing iteration from the records included on full text, after the user confirmed it. */
    snowball(id: string, direction: SnowballDirection, confirmed: true): Promise<ActionResult>
    discardSearch(id: string, searchId: string, reason: string): Promise<ActionResult>
    queue(id: string, query: QueueQuery): Promise<MappingRecordRow[]>
    decide(id: string, req: DecideRequest): Promise<DecideResult>
    undo(id: string, decisionId: string): Promise<ActionResult>
    resolveConflict(id: string, recordId: string, phase: Phase, keepDecisionId: string): Promise<ActionResult>
    /** «Es el mismo» / «Son distintos» about the pair shown (`otherId`); `conflict` when the pair changed since. */
    resolveDuplicate(id: string, recordId: string, otherId: string, same: boolean): Promise<ActionResult>
    /** What «Sugerir cribado» would cost, before asking. */
    suggestPlan(id: string, phase: Phase): Promise<ScreeningPlan>
    /** «Sugerir» in the cost confirmation: `confirmed` is that click, `recordIds` the plan's (nothing else is asked about). */
    suggest(id: string, phase: Phase, recordIds: string[], confirmed: true): Promise<RunBatchResult>
    /** What «Agregar a la biblioteca» would add (these records, or all) and its estimate. */
    ingestPlan(id: string, recordIds?: string[]): Promise<IngestPlan>
    /** After the confirmation: adds the plan's records that are still included and not library papers yet. */
    ingest(id: string, recordIds: string[], confirmed: true): Promise<CountResult>
  }
  exports: {
    /** Asks where to save, then writes the file there. */
    save(defaultName: string, data: string | Uint8Array): Promise<SaveResult>
  }
  /** «Redacción»: reads only; nothing here writes to the project. */
  writing: {
    /** The keys a text may cite: library papers (and whether their text is indexed) and trashed ones. */
    library(): Promise<WritingLibrary>
    /**
     * Asks for a .tex, .md or .org file in the app's dialog; null when the user cancels. The path stays in the main
     * process: `bibtex` names the file by the token, once.
     */
    chooseFile(): Promise<ImportChoice | null>
    /** «BibTeX»: the cited entries of pasted text, or of the chosen file and what it includes inside its folder. */
    bibtex(source: WritingSource): Promise<ChapterBibResult>
    /** «Esquema»: the facets, papers and confirmed relations of the chosen set. */
    outlineData(scope: OutlineScope): Promise<OutlineDataResult>
  }
  sync: {
    status(): Promise<SyncStatus>
    /** «Sincronizar»: commit, fetch, merge and push; `conflicts` when decisions are waiting. */
    run(): Promise<SyncResult>
    conflicts(): Promise<ConflictItem[]>
    diff(id: string): Promise<ConflictDiff>
    /**
     * «Terminar sincronización» with a choice per conflict id, each with the `version` it was made for; a choice whose
     * conflict changed since is not taken (the result is `conflicts` again).
     */
    resolve(choices: Record<string, ConflictDecision>): Promise<SyncResult>
    /** «Cancelar»: forgets the decisions; the local commit stays, unpushed. */
    abort(): Promise<void>
    /** «Inicializar repositorio» (when there is none) and/or adds `url` as origin, then the first sync. */
    init(url: string | null): Promise<SyncResult>
  }
  app: {
    /** «Abrir carpeta de registros»: the folder of main.log, in the system's file manager. */
    openLogs(): Promise<ActionResult>
  }
  /** Settings → Aplicación → «API local» (turned on and off with `settings.set`). The token never reaches the window. */
  localApi: {
    status(): Promise<LocalApiStatus | null>
    /** «Copiar token»: the main process puts it on the clipboard; false when there is none yet. */
    copyToken(): Promise<boolean>
    /** «Regenerar token». */
    regenerateToken(): Promise<LocalApiStatus | null>
    /** `open_in_app` from an editor: show this paper. */
    onOpenPaper(callback: (request: ApiOpenPaper) => void): () => void
  }
  log: {
    /** Sends an uncaught error of the window to the app log; fire and forget. */
    rendererError(report: RendererErrorReport): void
  }
  on(event: ResearchEvent, callback: () => void): () => void
  /** Acknowledges a 'flush-request' once pending saves have finished. */
  flushDone(): void
  /** Answers a 'close-request': close the window, or keep it open. */
  closeDecision(decision: CloseDecision): void
  /** Absolute path of a dropped file. */
  pathForFile(file: File): string
}
