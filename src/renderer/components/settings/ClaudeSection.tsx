import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LLM_MODELS, type LlmConfig, type LlmModel } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

export function ClaudeSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [model, setModel] = useState<LlmModel>('sonnet')
  const [autoSummarize, setAutoSummarize] = useState(false)
  const [perOperation, setPerOperation] = useState('')
  const [perBatch, setPerBatch] = useState('')
  const [perMonth, setPerMonth] = useState('')
  const [maxInput, setMaxInput] = useState('')
  const [monthSpent, setMonthSpent] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    window.research.llm.info().then((info) => {
      const config = info.config
      setModel(config.model)
      setAutoSummarize(config.auto_summarize)
      setPerOperation(String(config.budget.per_operation_usd))
      setPerBatch(String(config.budget.per_batch_usd))
      setPerMonth(config.budget.per_month_usd === null ? '' : String(config.budget.per_month_usd))
      setMaxInput(String(config.max_input_chars))
      setMonthSpent(info.monthSpentUsd)
    }, () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const save = (patch: Partial<LlmConfig>): void => {
    setError(null)
    window.research.llm.update(patch).then(
      (result) => {
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  const saveBudget = (patch: Partial<LlmConfig['budget']>): void => {
    save({
      budget: {
        per_operation_usd: Number(perOperation),
        per_batch_usd: Number(perBatch),
        per_month_usd: perMonth.trim() === '' ? null : Number(perMonth),
        ...patch
      }
    })
  }

  return (
    <section className="claude-section">
      <h3>{t('settings.claude_section')}</h3>
      {error && <div className="banner error">{error}</div>}
      <label className="field">
        <span>{t('settings.model')}</span>
        <select
          value={model}
          onChange={(e) => {
            const next = e.target.value as LlmModel
            setModel(next)
            save({ model: next })
          }}
        >
          {LLM_MODELS.map((m) => (
            <option key={m} value={m}>
              {t(`settings.models.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field checkbox">
        <input
          type="checkbox"
          checked={autoSummarize}
          onChange={(e) => {
            const next = e.target.checked
            setAutoSummarize(next)
            save({ auto_summarize: next })
          }}
        />
        <span>{t('settings.auto_summarize')}</span>
      </label>
      <label className="field">
        <span>{t('settings.budget_operation')}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={perOperation}
          onChange={(e) => setPerOperation(e.target.value)}
          onBlur={() => {
            const value = Number(perOperation)
            if (Number.isFinite(value) && value > 0) saveBudget({ per_operation_usd: value })
          }}
        />
      </label>
      <label className="field">
        <span>{t('settings.budget_batch')}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={perBatch}
          onChange={(e) => setPerBatch(e.target.value)}
          onBlur={() => {
            const value = Number(perBatch)
            if (Number.isFinite(value) && value > 0) saveBudget({ per_batch_usd: value })
          }}
        />
      </label>
      <label className="field">
        <span>{t('settings.budget_month')}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={perMonth}
          onChange={(e) => setPerMonth(e.target.value)}
          onBlur={() => {
            if (perMonth.trim() === '') {
              saveBudget({ per_month_usd: null })
              return
            }
            const value = Number(perMonth)
            if (Number.isFinite(value) && value > 0) saveBudget({ per_month_usd: value })
          }}
        />
      </label>
      <label className="field">
        <span>{t('settings.max_input')}</span>
        <input
          type="number"
          min="1"
          step="1"
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={() => {
            const value = Number(maxInput)
            if (Number.isInteger(value) && value > 0) save({ max_input_chars: value })
          }}
        />
      </label>
      <div className="field">
        <span>{t('settings.month_spent', { amount: monthSpent.toFixed(2) })}</span>
        <small className="muted">{t('settings.estimate_note')}</small>
      </div>
    </section>
  )
}
