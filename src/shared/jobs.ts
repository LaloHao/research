import type { LlmModel } from './summary'

export type JobSpec =
  | { type: 'ingest_identifier'; input: string }
  | { type: 'ingest_pdf'; path: string }
  | { type: 'update_metadata'; paperId: string; input?: string }
  | { type: 'summarize'; paperId: string; batchId?: string; force?: boolean; model?: LlmModel }

export type JobType = JobSpec['type']

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobRecord {
  id: number
  spec: JobSpec
  state: JobState
  /** An outcome ('added' | 'merged' | 'duplicate'), an error code, or a raw error message. */
  message: string | null
  paperId: string | null
  createdAt: string
  updatedAt: string
}
