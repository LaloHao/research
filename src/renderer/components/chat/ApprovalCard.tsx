import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PendingApproval } from '../../../shared/chatActions'
import { actionText, approvalReason, costLines, minutesLeft } from '../../lib/chatActions'
import { errorText } from '../../lib/errorText'

interface ApprovalCardProps {
  chatId: string
  approval: PendingApproval
  /** A decision settled: the conversation reads its approvals again (a resolved decision does not mean it was approved). */
  onSettled: () => void
  /** An error that outlives the card (the approval is gone, so the card is about to vanish): shown by the conversation. */
  onGone: (text: string) => void
}

/**
 * An action waiting for the user: what it would do, why it asks, and what it costs. «Elegir PDF y adjuntar» on attach_pdf
 * opens the app's own file dialog (in the main process; cancelling it leaves the card pending). The card goes away when
 * the answer's approvals change, never because of the click's own result. Every value that came from the model is shown
 * as plain text.
 */
export function ApprovalCard({ chatId, approval, onSettled, onGone }: ApprovalCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const detailsId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const decide = (approve: boolean): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.research.chats.decide(chatId, approval.id, approve).then(
      (r) => {
        setBusy(false)
        if (!r.ok && r.error === 'approval_gone') onGone(errorText(t, r.error))
        else if (!r.ok) setError(errorText(t, r.error))
        onSettled()
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
        onSettled()
      }
    )
  }
  const title = t('chat.actions.approval_title', { action: actionText(t, approval.tool, approval.args) })
  const { preview } = approval
  return (
    <div className="chat-approval" role="alertdialog" aria-label={title} aria-describedby={detailsId}>
      <strong>{title}</strong>
      <div id={detailsId} className="chat-approval-details">
        <p className="small">{approvalReason(t, approval)}</p>
        {approval.request && <p className="small muted">{t('chat.actions.requested', { request: approval.request })}</p>}
        {preview.papers.length > 0 && (
          <ul className="small">
            {preview.papers.map((p) => (
              <li key={p.id}>
                {p.title} <span className="muted">({p.id})</span>
              </li>
            ))}
          </ul>
        )}
        {preview.relations ? <p className="small chat-approval-warning">{t('chat.actions.relations_deleted', { count: preview.relations })}</p> : null}
        {preview.replacesPdf && <p className="small chat-approval-warning">{t('chat.actions.replaces_pdf')}</p>}
        {preview.conflicts?.map((c) => (
          <p key={c.path} className="small">
            {t(`chat.actions.conflict_choice.${c.choice}`, { path: c.path })}
          </p>
        ))}
        {preview.cost &&
          costLines(t, preview.cost).map((line) => (
            <p key={line} className="small">
              {line}
            </p>
          ))}
      </div>
      <div className="row small">
        <button className="small primary" disabled={busy} onClick={() => decide(true)}>
          {t(approval.pickPdf ? 'chat.actions.pick_pdf' : 'chat.actions.approve')}
        </button>
        {/* Focus lands on the safe choice: Enter on a freshly shown card never approves, and no key binding approves. */}
        <button className="small" autoFocus disabled={busy} onClick={() => decide(false)}>
          {t('chat.actions.deny')}
        </button>
        <span className="muted">{t('chat.actions.expires', { count: minutesLeft(approval.expiresAt, now) })}</span>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
