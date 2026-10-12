import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { JobRecord } from '../../../shared/jobs'
import type { PaperDetail } from '../../../shared/library'
import { LLM_MODELS, type LlmModel, type SummaryPlan, type ThesisContext } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { facetCards, summarizeAvailability, summaryCards, thesisCard, unfilledFacetKeys } from '../../lib/summaryView'
import { FacetCard } from './FacetCard'
import { FieldCard, formatDate, type OpenEvidence, type RunAction } from './FieldCard'
import { ThesisCard } from './ThesisCard'

export function SummaryTab({ detail, onOpenEvidence }: { detail: PaperDetail; onOpenEvidence: OpenEvidence }): React.JSX.Element {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [estimate, setEstimate] = useState<number | null>(null)
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fillPlan, setFillPlan] = useState<SummaryPlan | null>(null)
  const [fillConfirm, setFillConfirm] = useState(false)
  const [filling, setFilling] = useState(false)
  const fillRequest = useRef(0)
  // What filling this paper's new facets would cost; 0 papers while it has none, or a fill or summary is queued.
  const refreshFill = useCallback(() => {
    const token = ++fillRequest.current
    window.research.facets.fillPlan([detail.id]).then(
      (plan) => {
        if (token === fillRequest.current) setFillPlan(plan)
      },
      () => {
        if (token !== fillRequest.current) return
        setFillPlan(null)
        setError(errorText(t, 'unknown'))
      }
    )
  }, [detail.id, t])

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
  useEffect(refreshFill, [refreshFill])
  useEvent('jobs-changed', refreshFill)
  useEvent('library-changed', refreshFill)
  useEvent('project-changed', refreshFill)
  useEvent('facets-changed', refreshFill)
  useEffect(() => {
    setError(null)
    setFillConfirm(false)
  }, [detail.id])
  const unfilledCount = detail.summary ? unfilledFacetKeys(detail.form, detail.extraction, detail.summaryStatus).length : 0
  // A confirmation does not outlive its banner (the summary went stale or the facets got filled).
  useEffect(() => {
    if (unfilledCount === 0) setFillConfirm(false)
  }, [unfilledCount])

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
  const unfilled = unfilledFacetKeys(detail.form, detail.extraction, detail.summaryStatus)
  const canFill = !busy && !filling && !!fillPlan && fillPlan.count > 0
  // Queued only after the user confirms the estimate and the batch cap.
  const fillNew = (): void => {
    if (!canFill) return
    setFilling(true)
    void run(async () => {
      const r = await window.research.facets.fill([detail.id])
      return r.ok ? { ok: true as const } : r
    }).finally(() => {
      setFilling(false)
      setFillConfirm(false)
    })
  }

  return (
    <div className="summary-tab">
      <header className="summary-header">
        <div className="row small">
          <span className="muted">
            {t('summary.meta', { model: summary.generated.model, date: formatDate(summary.generated.at), cost: summary.generated.cost_usd_est.toFixed(2) })}
          </span>
          {detail.summaryStatus === 'stale' && <span className="badge badge-incomplete">{t('summary.stale')}</span>}
          {summary.generated.truncated && <span className="muted">{t('summary.truncated')}</span>}
        </div>
        <div className="row">
          {/* A summary made from truncated text is forced again by the main process. */}
          <button disabled={busy} onClick={() => summarize()}>
            {t('summary.regenerate')}
          </button>
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              const model = e.target.value as LlmModel | ''
              if (model) summarize({ model })
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
          {availability === 'too_long' && <button onClick={() => summarize({ force: true })}>{t('summary.force')}</button>}
        </div>
        {lastError}
        {actionError}
        {unfilled.length > 0 && (
          <div className="banner warning">
            <span>{t('facets.unfilled_banner', { keys: unfilled.join(', ') })}</span>
            {fillConfirm && fillPlan ? (
              <>
                <span>{t('facets.fill_confirm', { count: fillPlan.count, cost: fillPlan.estimateUsd.toFixed(2), limit: fillPlan.batchLimitUsd.toFixed(2) })}</span>
                <button className="primary" disabled={!canFill} autoFocus onClick={fillNew}>
                  {t('library.confirm')}
                </button>
                <button disabled={filling} onClick={() => setFillConfirm(false)}>
                  {t('jobs.cancel')}
                </button>
              </>
            ) : (
              <button disabled={!canFill} onClick={() => setFillConfirm(true)}>
                {t('facets.fill_paper', { cost: fillPlan ? fillPlan.estimateUsd.toFixed(2) : '…' })}
              </button>
            )}
          </div>
        )}
      </header>

      {summaryCards(summary).map((card) => (
        <FieldCard key={card.key} paperId={detail.id} card={card} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
      ))}

      {facets.length > 0 && (
        <section>
          <h3>{t('summary.classification')}</h3>
          {facets.map(({ def, entry }) => (
            <FacetCard
              key={def.key}
              paperId={detail.id}
              def={def}
              entry={entry}
              fallback={fallback}
              onOpenEvidence={onOpenEvidence}
              run={run}
              unfilled={unfilled.includes(def.key)}
            />
          ))}
        </section>
      )}

      {relation && (
        <section>
          <h3>{t('summary.thesis_section')}</h3>
          {relation.status === 'no_context' ? (
            <p className="muted">{t('summary.thesis_missing')}</p>
          ) : relation.relation ? (
            <ThesisCard paperId={detail.id} outdated={detail.thesisOutdated} relation={relation.relation} questions={relation.questions} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
          ) : (
            <p className="muted">{t('summary.thesis_pending')}</p>
          )}
        </section>
      )}
    </div>
  )
}
