import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JobRecord } from '../../../shared/jobs'
import { useEvent } from '../../hooks/useEvent'
import { browserRetryUrl } from '../../lib/appBrowser'
import { jobDetail, jobLabel, jobProgress, visibleJobs } from '../../lib/jobLabel'

export function JobsPanel({ onSelectPaper }: { onSelectPaper: (id: string) => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const refresh = useCallback(() => {
    window.research.jobs.list().then(setJobs, () => undefined)
  }, [])
  useEffect(refresh, [refresh])
  useEvent('jobs-changed', refresh)

  const visible = visibleJobs(jobs)
  if (visible.length === 0) return null
  return (
    <section className="jobs">
      <h4>{t('jobs.title')}</h4>
      <ul>
        {visible.map((job) => {
          const detail = jobDetail(t, job)
          const active = job.state === 'queued' || job.state === 'running'
          const browse = browserRetryUrl(job)
          return (
            <li key={job.id} className={`job job-${job.state}`}>
              <button className="link" disabled={!job.paperId} onClick={() => job.paperId && onSelectPaper(job.paperId)}>
                {jobLabel(t, job)}
              </button>
              <span className="muted small">
                {t(`jobs.state.${job.state}`)}
                {jobProgress(job) ? ` ${jobProgress(job)}` : ''}
                {detail ? ` — ${detail}` : ''}
              </span>
              {browse && (
                <button className="small" onClick={() => void window.research.library.openInBrowser(browse)}>
                  {t('jobs.open_in_browser')}
                </button>
              )}
              {active && (
                <button className="small" onClick={() => void window.research.jobs.cancel(job.id)}>
                  {t('jobs.cancel')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
