import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import { LLM_MODELS, type LlmModel } from '../../../shared/summary'
import { SUMMARY_FILTERS, type SummaryFilter } from '../../lib/badges'
import { errorText } from '../../lib/errorText'

interface Confirm {
  count: number
  estimateUsd: number
  batchLimitUsd: number
  model?: LlmModel
  /** True for "Regenerar filtrados con…"; false for "Resumir pendientes". */
  filtered: boolean
}

export function SummaryToolbar({
  filter,
  onFilterChange,
  model,
  onModelChange,
  visibleRows
}: {
  filter: SummaryFilter
  onFilterChange: (filter: SummaryFilter) => void
  model: LlmModel | 'any'
  onModelChange: (model: LlmModel | 'any') => void
  visibleRows: PaperRow[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [batchModel, setBatchModel] = useState<LlmModel | ''>('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [none, setNone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openPendingConfirm = (): void => {
    setError(null)
    setNone(false)
    window.research.summary.plan().then(
      (plan) => {
        if (plan.count === 0) {
          setNone(true)
          return
        }
        setConfirm({ count: plan.count, estimateUsd: plan.estimateUsd, batchLimitUsd: plan.batchLimitUsd, model: batchModel || undefined, filtered: false })
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const openFilteredConfirm = (selected: LlmModel): void => {
    setError(null)
    setNone(false)
    window.research.llm.info().then(
      (info) => {
        const count = visibleRows.filter((row) => row.text_status === 'ok').length
        setConfirm({
          count,
          estimateUsd: count * info.estimatePerPaperUsd,
          batchLimitUsd: info.config.budget.per_batch_usd,
          model: selected,
          filtered: true
        })
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const runConfirmed = (): void => {
    if (!confirm) return
    const ids = confirm.filtered ? visibleRows.filter((row) => row.text_status === 'ok').map((row) => row.id) : undefined
    window.research.summary.runBatch({ model: confirm.model, ids }).then(
      (result) => {
        if (result.ok) setConfirm(null)
        else setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  return (
    <div className="summary-toolbar">
      <div className="row small">
        <select value={filter} onChange={(e) => onFilterChange(e.target.value as SummaryFilter)}>
          {SUMMARY_FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`library.summary_filter.${f}`)}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => onModelChange(e.target.value as LlmModel | 'any')} aria-label={t('library.model_filter.label')}>
          <option value="any">{t('library.model_filter.any')}</option>
          {LLM_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="row small">
        <select value={batchModel} onChange={(e) => setBatchModel(e.target.value as LlmModel | '')} aria-label={t('library.batch_model')}>
          <option value="">{t('library.batch_model')}</option>
          {LLM_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button onClick={openPendingConfirm}>{t('library.summarize_pending')}</button>
        {filter !== 'all' && (
          <select
            value=""
            onChange={(e) => {
              const selected = e.target.value as LlmModel | ''
              if (selected) openFilteredConfirm(selected)
            }}
          >
            <option value="">{t('library.regenerate_filtered')}</option>
            {LLM_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </div>
      {none && <div className="banner warning">{t('library.batch_none')}</div>}
      {confirm && (
        <div className="banner">
          <span>{t('library.batch_confirm', { count: confirm.count, cost: confirm.estimateUsd.toFixed(2), limit: confirm.batchLimitUsd.toFixed(2) })}</span>
          <button className="primary" onClick={runConfirmed}>
            {t('library.confirm')}
          </button>
          <button onClick={() => setConfirm(null)}>{t('jobs.cancel')}</button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
    </div>
  )
}
