import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LLM_MODELS, type LlmConfig, type LlmModel } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { parseCap, parseCount, parseUsd, type NumberIssue, type Parsed } from '../../lib/numberField'

type NumericField = 'perOperation' | 'perBatch' | 'perMonth' | 'maxInput'

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
  const [issues, setIssues] = useState<Partial<Record<NumericField, NumberIssue>>>({})

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
      setIssues({})
    }, () => undefined)
  }, [])
  useEffect(load, [load])
  useEvent('project-changed', load)

  const save = (patch: Partial<Omit<LlmConfig, 'budget'>> & { budget?: Partial<LlmConfig['budget']> }): void => {
    setError(null)
    window.research.llm.update(patch).then(
      (result) => {
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => setError(errorText(t, 'unknown'))
    )
  }

  /** Sends only the changed budget field; the main process deep-merges it into the current budget. */
  const saveBudget = (patch: Partial<LlmConfig['budget']>): void => save({ budget: patch })

  const edit = (field: NumericField, set: (v: string) => void, value: string): void => {
    set(value)
    setIssues(({ [field]: _, ...rest }) => rest)
  }

  /** Saves a valid value; an invalid one stays in the field with the reason shown under it. */
  function commit<T>(field: NumericField, parsed: Parsed<T>, send: (value: T) => void): void {
    if (parsed.ok) {
      setIssues(({ [field]: _, ...rest }) => rest)
      send(parsed.value)
    } else {
      setIssues((current) => ({ ...current, [field]: parsed.issue }))
    }
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
      <NumberField
        id="budget-operation"
        label={t('settings.budget_operation')}
        value={perOperation}
        issue={issues.perOperation}
        onChange={(v) => edit('perOperation', setPerOperation, v)}
        onBlur={() => commit('perOperation', parseUsd(perOperation), (value) => saveBudget({ per_operation_usd: value }))}
      />
      <NumberField
        id="budget-batch"
        label={t('settings.budget_batch')}
        value={perBatch}
        issue={issues.perBatch}
        onChange={(v) => edit('perBatch', setPerBatch, v)}
        onBlur={() => commit('perBatch', parseUsd(perBatch), (value) => saveBudget({ per_batch_usd: value }))}
      />
      <NumberField
        id="budget-month"
        label={t('settings.budget_month')}
        value={perMonth}
        issue={issues.perMonth}
        onChange={(v) => edit('perMonth', setPerMonth, v)}
        onBlur={() => commit('perMonth', parseCap(perMonth), (value) => saveBudget({ per_month_usd: value }))}
      />
      <NumberField
        id="max-input"
        label={t('settings.max_input')}
        value={maxInput}
        issue={issues.maxInput}
        integer
        onChange={(v) => edit('maxInput', setMaxInput, v)}
        onBlur={() => commit('maxInput', parseCount(maxInput), (value) => save({ max_input_chars: value }))}
      />
      <div className="field">
        <span>{t('settings.month_spent', { amount: monthSpent.toFixed(2) })}</span>
        <small className="muted">{t('settings.estimate_note')}</small>
      </div>
    </section>
  )
}

interface NumberFieldProps {
  id: string
  label: string
  value: string
  issue: NumberIssue | undefined
  integer?: boolean
  onChange: (value: string) => void
  onBlur: () => void
}

/** A text input for numbers (so a half-typed value is never read as empty) with its own error under it. */
function NumberField({ id, label, value, issue, integer, onChange, onBlur }: NumberFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const errorId = `${id}-error`
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        className={issue ? 'invalid' : undefined}
        aria-invalid={issue ? true : undefined}
        aria-describedby={issue ? errorId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {issue && (
        <small id={errorId} className="field-error" role="alert">
          {t(`settings.invalid.${issue}`)}
        </small>
      )}
    </label>
  )
}
