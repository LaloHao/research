import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionView } from '../../../shared/chat'
import { actionOutcome, actionText } from '../../lib/chatActions'
import { errorText } from '../../lib/errorText'

/**
 * One action of the conversation: what it did, how it ended, and «Deshacer» while it is offered. Every value that came
 * from the model is shown as plain text.
 */
export function ActionRecord({ chatId, message }: { chatId: string; message: ActionView }): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const undo = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    // The conversation reloads on chats-changed once the undo is recorded; the button goes with `undoable`.
    window.research.chats.undo(chatId, message.id).then(
      (r) => {
        // Done: the button stays disabled until the reload takes it away with `undoable`.
        if (r.ok) return
        setBusy(false)
        setError(errorText(t, r.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }
  return (
    <div className={`chat-action chat-action-${message.state}${message.undone ? ' chat-action-undone' : ''}`}>
      <div className="chat-message-head muted small">
        {t('chat.actions.record_head')}
        {message.undone && <> · {t('chat.actions.undone')}</>}
      </div>
      <p>{actionText(t, message.tool, message.args)}</p>
      <p className="muted small">{actionOutcome(t, message)}</p>
      {message.undoable && (
        <div className="row small">
          <button className="small" disabled={busy} onClick={undo}>
            {t('chat.actions.undo')}
          </button>
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
