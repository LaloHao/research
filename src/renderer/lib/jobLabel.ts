import type { TFunction } from 'i18next'
import type { JobRecord } from '../../shared/jobs'
import { errorText } from './errorText'

export function jobLabel(t: TFunction, job: JobRecord): string {
  switch (job.spec.type) {
    case 'ingest_identifier':
      return t('jobs.ingest_identifier', { input: job.spec.input })
    case 'ingest_pdf':
      return t('jobs.ingest_pdf', { file: job.spec.path.split(/[\\/]/).pop() })
    case 'attach_pdf':
      return t('jobs.attach_pdf', { id: job.spec.paperId })
    case 'update_metadata':
      return t('jobs.update_metadata', { id: job.spec.paperId })
    case 'summarize':
      return t('jobs.summarize', { id: job.spec.paperId })
    case 'citations':
      return t('jobs.citations', { id: job.spec.paperId })
    case 'cited_by':
      return t('jobs.cited_by', { id: job.spec.paperId })
    case 'embed':
      return t('jobs.embed', { id: job.spec.paperId })
    case 'model_download':
      return t('jobs.model_download')
    case 'suggest_relations':
      return t('jobs.suggest_relations', { id: job.spec.paperId })
    case 'fill_facets':
      return t('jobs.fill_facets', { id: job.spec.paperId })
    case 'suggest_facets':
      return t(job.spec.auto ? 'jobs.suggest_facets_auto' : 'jobs.suggest_facets')
    case 'mapping_search':
      return t('jobs.mapping_search', { query: job.spec.query })
    case 'mapping_snowball':
      return t('jobs.mapping_snowball')
    case 'screen_suggest':
      return t('jobs.screen_suggest', { count: job.spec.recordIds.length })
    case 'ingest_record':
      return t('jobs.ingest_record')
  }
}

export function jobDetail(t: TFunction, job: JobRecord): string | null {
  if (job.state === 'done' && job.message) return t(`jobs.outcome.${job.message}`, { defaultValue: job.message })
  if (job.state === 'failed' && job.message) return errorText(t, job.message)
  return null
}

/** "43 %" while a running job reports progress (e.g. the model download). */
export function jobProgress(job: JobRecord): string | null {
  return job.state === 'running' && job.progress !== null ? `${Math.round(job.progress * 100)} %` : null
}

/** Active jobs plus the most recent finished ones (input is newest first). */
export function visibleJobs(jobs: JobRecord[], finishedLimit = 5): JobRecord[] {
  let finished = 0
  return jobs.filter((job) => {
    if (job.state === 'queued' || job.state === 'running') return true
    finished++
    return finished <= finishedLimit
  })
}
