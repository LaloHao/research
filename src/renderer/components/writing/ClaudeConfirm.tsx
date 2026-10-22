import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LLM_MODELS, type LlmModel } from '../../../shared/summary'
import type { WritingPlanKind, WritingRunPlan } from '../../../shared/writing/api'
import { errorText } from '../../lib/errorText'
import { trapTab } from '../../lib/focusTrap'
import { writingPlanLines } from '../../lib/writing'

/**
 * The cost confirmation of every Claude operation of «Redacción», as a dialog: the model (the project's by default),
 * what the run would cost (the learned estimate, the operation's own cap, the month's spending) and «Confirmar».
 * Nothing runs until that click. With `plan` the caller already asked for the numbers (a check whose cost depends on
 * the text); otherwise the dialog asks `writing.plan(kind)` itself. `lines` replaces the default description.
 */
export function ClaudeConfirm({
  kind,
  title,
  plan: given,
  lines,
  confirmLabel,
  canRun = true,
  model: initialModel,
  onConfirm,
  onCancel
}: {
  kind: WritingPlanKind
  title: string
  plan?: WritingRunPlan
  lines?: string[]
  confirmLabel?: string
  canRun?: boolean
  /** The model selected at first (a draft's own); the plan's (the project's) otherwise. */
  model?: LlmModel
  onConfirm: (model: LlmModel) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [fetched, setFetched] = useState<WritingRunPlan | null>(null)
  const [model, setModel] = useState<LlmModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const plan = given ?? fetched

  useEffect(() => {
    if (given) return
    let live = true
    window.research.writing.plan(kind).then(
      (p) => live && setFetched(p),
      (e: unknown) => live && setError(errorText(t, e instanceof Error ? e.message : 'unknown'))
    )
    return () => {
      live = false
    }
  }, [given, kind, t])

  const chosen = model ?? (plan ? (initialModel ?? plan.model) : null)
  const overMonth = plan !== null && plan.monthCapUsd !== null && plan.monthSpentUsd >= plan.monthCapUsd
  return (
    <div className="modal-backdrop">
      <div
        className="modal writing-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else trapTab(e)
        }}
      >
        <h3 id={titleId}>{title}</h3>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {!plan && !error && <p className="muted small">{t('writing.claude.loading_plan')}</p>}
        {plan && chosen && (
          <>
            <label className="row">
              <span>{t('writing.claude.model')}</span>
              <select value={chosen} onChange={(e) => setModel(e.target.value as LlmModel)}>
                {LLM_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {t(`settings.models.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            {(lines ?? writingPlanLines(t, kind, plan)).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {overMonth && <p className="warning-text small">{t('writing.claude.month_reached')}</p>}
          </>
        )}
        <div className="row">
          <button autoFocus onClick={onCancel}>
            {t('writing.claude.cancel')}
          </button>
          <button className="primary" disabled={!plan || !chosen || overMonth || !canRun} onClick={() => chosen && onConfirm(chosen)}>
            {confirmLabel ?? t('writing.claude.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
