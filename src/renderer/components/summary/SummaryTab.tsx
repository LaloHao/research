import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { JobRecord } from '../../../shared/jobs'
import type { PaperDetail } from '../../../shared/library'
import { LLM_MODELS, type LlmModel, type ThesisContext } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { facetCards, summarizeAvailability, summaryCards, thesisCard } from '../../lib/summaryView'
import { FacetCard } from './FacetCard'
import { FieldCard, formatDate, type OpenEvidence, type RunAction } from './FieldCard'
import { ThesisCard } from './ThesisCard'

export function SummaryTab({ detail, onOpenEvidence }: { detail: PaperDetail; onOpenEvidence: OpenEvidence }): React.JSX.Element {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [estimate, setEstimate] = useState<number | null>(null)
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshJobs = useCallback(() => {
    window.research.jobs.list().then(setJobs, () => setJobs([]))
  }, [])
  const refreshProject = useCallback(() => {
    window.research.llm.info().then(
      (info) => setEstimate(info.estimatePerPaperUsd),
      () => setEstimate(null)
    )
    window.research.thesis.get().then(setThesis, () => setThesis(null))
  }, [])
  useEffect(refreshJobs, [refreshJobs])
  useEffect(refreshProject, [refreshProject])
  useEvent('jobs-changed', refreshJobs)
  useEvent('library-changed', refreshProject)
  useEvent('project-changed', refreshProject)
  useEffect(() => setError(null), [detail.id])

  const run: RunAction = async (action: () => Promise<ActionResult>) => {
    setError(null)
    try {
      const result = await action()
      if (result.ok) return true
      setError(errorText(t, result.error))
    } catch {
      setError(errorText(t, 'unknown'))
    }
    return false
  }

  const availability = summarizeAvailability(detail, jobs)
  const summarize = (opts?: { force?: boolean; model?: LlmModel }): void => void run(() => window.research.summary.run(detail.id, opts))
  const force = detail.summaryStatus === 'too_long'
  const lastError = detail.summaryError && <div className="banner error">{t('summary.last_error', { error: errorText(t, detail.summaryError) })}</div>
  const actionError = error && <div className="banner error">{error}</div>

  const { summary } = detail
  if (!summary) {
    return (
      <div className="summary-tab">
        {lastError}
        {actionError}
        <div className="row">
          <button className="primary" disabled={availability !== 'ready' || estimate === null} onClick={() => summarize()}>
            {t('summary.summarize', { cost: estimate === null ? '…' : estimate.toFixed(2) })}
          </button>
          {availability !== 'ready' && <span className="muted">{t(`summary.unavailable.${availability}`)}</span>}
          {availability === 'too_long' && <button onClick={() => summarize({ force: true })}>{t('summary.force')}</button>}
        </div>
      </div>
    )
  }

  const busy = availability === 'running' || availability === 'no_text'
  const fallback = { model: summary.generated.model, at: summary.generated.at }
  const facets = facetCards(detail.form, detail.extraction)
  const relation = thesis ? thesisCard(detail.extraction, thesis) : null

  return (
    <div className="summary-tab">
      <header className="summary-header">
        <div className="row small">
          <span className="muted">
            {t('summary.meta', { model: summary.generated.model, date: formatDate(summary.generated.at), cost: summary.generated.cost_usd_est.toFixed(2) })}
          </span>
          {detail.summaryStatus === 'stale' && <span className="badge badge-incomplete">{t('summary.stale')}</span>}
        </div>
        <div className="row">
          <button disabled={busy} onClick={() => summarize(force ? { force } : undefined)}>
            {t('summary.regenerate')}
          </button>
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              const model = e.target.value as LlmModel | ''
              if (model) summarize({ model, force })
            }}
          >
            <option value="">{t('summary.regenerate_with')}</option>
            {LLM_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button onClick={() => void run(() => window.research.summary.verifyAll(detail.id))}>{t('summary.verify_all')}</button>
          {availability !== 'ready' && <span className="muted small">{t(`summary.unavailable.${availability}`)}</span>}
        </div>
        {lastError}
        {actionError}
      </header>

      {summaryCards(summary).map((card) => (
        <FieldCard key={card.key} paperId={detail.id} card={card} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
      ))}

      {facets.length > 0 && (
        <section>
          <h3>{t('summary.classification')}</h3>
          {facets.map(({ def, entry }) => (
            <FacetCard key={def.key} paperId={detail.id} def={def} entry={entry} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
          ))}
        </section>
      )}

      {relation && (
        <section>
          <h3>{t('summary.thesis_section')}</h3>
          {relation.status === 'no_context' ? (
            <p className="muted">{t('summary.thesis_missing')}</p>
          ) : relation.relation ? (
            <ThesisCard paperId={detail.id} relation={relation.relation} questions={relation.questions} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
          ) : (
            <p className="muted">{t('summary.thesis_pending')}</p>
          )}
        </section>
      )}
    </div>
  )
}
