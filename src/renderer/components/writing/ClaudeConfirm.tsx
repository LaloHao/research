import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LLM_MODELS, type LlmModel } from '../../../shared/summary'
import type { WritingPlanKind, WritingRunPlan } from '../../../shared/writing/api'
import { errorText } from '../../lib/errorText'
import { approxUsd } from '../../lib/mappings'

/**
 * The cost confirmation of a Claude operation of «Redacción»: the model (the configured one by default), the learned
 * estimate, the operation's own cap and the month's spending. Nothing runs until «Confirmar».
 */
export function ClaudeConfirm({
  kind,
  onConfirm,
  onCancel
}: {
  kind: WritingPlanKind
  onConfirm: (model: LlmModel) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [plan, setPlan] = useState<WritingRunPlan | null>(null)
  const [model, setModel] = useState<LlmModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.research.writing.plan(kind).then(
      (p) => {
        if (!live) return
        setPlan(p)
        setModel((m) => m ?? p.model)
      },
      (e: unknown) => live && setError(errorText(t, e instanceof Error ? e.message : 'unknown'))
    )
    return () => {
      live = false
    }
  }, [kind, t])

  if (error) {
    return (
      <div className="banner error" role="alert">
        {error}
      </div>
    )
  }
  if (!plan || !model) return <p className="muted small">{t('writing.claude.loading_plan')}</p>
  const overMonth = plan.monthCapUsd !== null && plan.monthSpentUsd >= plan.monthCapUsd
  return (
    <div className="writing-confirm banner" role="group" aria-label={t('writing.claude.confirm_label')}>
      <label className="row">
        <span>{t('writing.claude.model')}</span>
        <select value={model} onChange={(e) => setModel(e.target.value as LlmModel)}>
          {LLM_MODELS.map((m) => (
            <option key={m} value={m}>
              {t(`settings.models.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <ul className="small">
        <li>{t('writing.claude.estimate', { cost: approxUsd(plan.estimateUsd) })}</li>
        <li>{t(`writing.claude.cap_${kind}`, { cap: plan.capUsd.toFixed(2) })}</li>
        <li>
          {plan.monthCapUsd === null
            ? t('writing.claude.month_no_cap', { spent: plan.monthSpentUsd.toFixed(2) })
            : t('writing.claude.month', { spent: plan.monthSpentUsd.toFixed(2), cap: plan.monthCapUsd.toFixed(2) })}
        </li>
      </ul>
      {overMonth && <p className="warning-text small">{t('writing.claude.month_reached')}</p>}
      <div className="row">
        <button className="primary" disabled={overMonth} onClick={() => onConfirm(model)}>
          {t('writing.claude.confirm')}
        </button>
        <button onClick={onCancel}>{t('writing.claude.cancel')}</button>
      </div>
    </div>
  )
}
