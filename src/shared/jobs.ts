import type { OpenAlexType, Phase, SnowballDirection } from './mapping'
import type { LlmModel } from './summary'

export type JobSpec =
  | { type: 'ingest_identifier'; input: string }
  | { type: 'ingest_pdf'; path: string }
  | { type: 'attach_pdf'; paperId: string; path: string; replace: boolean }
  | { type: 'update_metadata'; paperId: string; input?: string }
  | { type: 'summarize'; paperId: string; batchId?: string; force?: boolean; model?: LlmModel }
  | { type: 'citations'; paperId: string; batchId?: string }
  | { type: 'cited_by'; paperId: string; batchId?: string }
  | { type: 'embed'; paperId: string }
  | { type: 'model_download' }
  | { type: 'suggest_relations'; paperId: string; batchId?: string; model?: LlmModel; force?: boolean }
  | { type: 'fill_facets'; paperId: string; batchId?: string }
  | { type: 'suggest_facets'; batchId?: string; auto?: boolean; model?: LlmModel }
  /** `replaces`: «Completar búsqueda», the logged search this one discards (and links to) once it is logged. */
  | { type: 'mapping_search'; mappingId: string; query: string; fromYear: number | null; toYear: number | null; types: OpenAlexType[]; cap: number; replaces?: string }
  | { type: 'mapping_snowball'; mappingId: string; direction: SnowballDirection }
  | { type: 'ingest_record'; mappingId: string; recordId: string; batchId?: string }
  | { type: 'screen_suggest'; mappingId: string; phase: Phase; recordIds: string[]; batchId?: string; model?: LlmModel }

export type JobType = JobSpec['type']

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobRecord {
  id: number
  spec: JobSpec
  state: JobState
  /** An outcome ('added' | 'merged' | 'duplicate' | 'pdf_attached' …), an error code, or a raw error message. */
  message: string | null
  /** 0..1 while a running job reports progress (e.g. a model download); null otherwise. */
  progress: number | null
  paperId: string | null
  createdAt: string
  updatedAt: string
}
