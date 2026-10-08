import type { TFunction } from 'i18next'
import type { JobRecord } from '../../shared/jobs'
import { errorText } from './errorText'

export function jobLabel(t: TFunction, job: JobRecord): string {
  switch (job.spec.type) {
    case 'ingest_identifier':
      return t('jobs.ingest_identifier', { input: job.spec.input })
    case 'ingest_pdf':
      return t('jobs.ingest_pdf', { file: job.spec.path.split(/[\\/]/).pop() })
    case 'update_metadata':
      return t('jobs.update_metadata', { id: job.spec.paperId })
  }
}

export function jobDetail(t: TFunction, job: JobRecord): string | null {
  if (job.state === 'done' && job.message) return t(`jobs.outcome.${job.message}`, { defaultValue: job.message })
  if (job.state === 'failed' && job.message) return errorText(t, job.message)
  return null
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
