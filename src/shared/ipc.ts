import type { JobRecord } from './jobs'
import type { PaperDetail, PaperRow } from './library'
import type { PdfPolicy } from './schemas'
import type { AppSettings } from './settings'

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
  jobsCancel: 'jobs:cancel'
} as const

export type ResearchEvent = 'library-changed' | 'jobs-changed' | 'project-changed'

export const eventChannel = (event: ResearchEvent): string => `event:${event}`

export interface ProjectInfo {
  root: string
  name: string
  contentLanguage: string
  pdfPolicy: PdfPolicy
}

export type NotesWriteResult = { ok: true; hash: string } | { ok: false; reason: 'conflict' }
export type PdfReadResult = { ok: true; data: Uint8Array | null } | { ok: false; error: string }

/** Everything the renderer can do, exposed as `window.research` by the preload. */
export interface ResearchApi {
  settings: {
    get(): Promise<AppSettings>
    /** Only the contact email; the last project path is managed by the main process. */
    set(patch: Pick<Partial<AppSettings>, 'contactEmail'>): Promise<AppSettings>
  }
  project: {
    current(): Promise<ProjectInfo | null>
    /** Asks for a folder, then creates the project there. Null when the user cancels. */
    create(name: string): Promise<ProjectInfo | null>
    open(): Promise<ProjectInfo | null>
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
  on(event: ResearchEvent, callback: () => void): () => void
  /** Absolute path of a dropped file. */
  pathForFile(file: File): string
}
