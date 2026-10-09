import type { JobRecord } from './jobs'
import type { PaperDetail, PaperRow, UserErrorCode } from './library'
import type { PdfPolicy } from './schemas'
import type { AppSettings } from './settings'
import type { FormInfo, LlmConfig, LlmModel, ReviewItem, Section, SummaryPlan, ThesisContext } from './summary'

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
  libraryUpdateMetadata: 'library:update-metadata',
  libraryReadPdf: 'library:read-pdf',
  libraryReadNotes: 'library:read-notes',
  libraryWriteNotes: 'library:write-notes',
  libraryShowInFolder: 'library:show-in-folder',
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
  llmShowProjectFile: 'llm:show-project-file',
  thesisGet: 'thesis:get',
  thesisUpdate: 'thesis:update',
  flushDone: 'window:flush-done'
} as const

/** `flush-request`: the window is about to close; save pending edits, then call `flushDone()`. */
export type ResearchEvent = 'library-changed' | 'jobs-changed' | 'project-changed' | 'flush-request'

export const eventChannel = (event: ResearchEvent): string => `event:${event}`

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
    /** Only the contact email; the last project path is managed by the main process. */
    set(patch: Pick<Partial<AppSettings>, 'contactEmail'>): Promise<AppSettings>
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
    updateMetadata(id: string, input?: string): Promise<void>
    readPdf(id: string): Promise<PdfReadResult>
    readNotes(id: string): Promise<{ text: string; hash: string | null }>
    writeNotes(id: string, text: string, hash: string | null): Promise<NotesWriteResult>
    showInFolder(id: string): Promise<void>
  }
  jobs: {
    list(): Promise<JobRecord[]>
    cancel(id: number): Promise<void>
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
    reviewQueue(ids?: string[]): Promise<ReviewItem[]>
    pageText(id: string, page: number | null): Promise<string>
  }
  llm: {
    info(): Promise<LlmInfo>
    /** The main process deep-merges `budget`, so a partial budget patch only touches the fields given. */
    update(patch: Partial<Omit<LlmConfig, 'budget'>> & { budget?: Partial<LlmConfig['budget']> }): Promise<ActionResult>
    createForm(): Promise<ActionResult>
    showProjectFile(): Promise<void>
  }
  thesis: {
    get(): Promise<ThesisContext>
    update(ctx: ThesisContext): Promise<ActionResult>
  }
  on(event: ResearchEvent, callback: () => void): () => void
  /** Acknowledges a 'flush-request' once pending saves have finished. */
  flushDone(): void
  /** Absolute path of a dropped file. */
  pathForFile(file: File): string
}
