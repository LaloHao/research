import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../lib/errorText'
import { restoreDetails, TRASH_UNDO_MS } from '../lib/trash'

/** «N papers movidos a la papelera · Deshacer» for a few seconds; undoing restores exactly those papers (never merging). */
export function useTrashUndo(): { show: (ids: string[]) => void; element: React.JSX.Element | null } {
  const { t } = useTranslation()
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stopTimer, [])

  const show = useCallback(
    (ids: string[]) => {
      stopTimer()
      setNotice(null)
      setUndo({ ids, text: t('trash.moved', { count: ids.length }) })
      timer.current = setTimeout(() => setUndo(null), TRASH_UNDO_MS)
    },
    [t]
  )

  /** Replaces «Deshacer» with what the undo could not do as planned, for the same few seconds. */
  const report = (error: boolean, text: string): void => {
    stopTimer()
    setUndo(null)
    setNotice({ error, text })
    timer.current = setTimeout(() => setNotice(null), TRASH_UNDO_MS)
  }

  const revert = (): void => {
    if (!undo || busy) return
    setBusy(true)
    window.research.trash.restore(undo.ids, false).then(
      (r) => {
        setBusy(false)
        const parts = [...restoreDetails(t, r), ...(r.conflicts.length > 0 ? [t('trash.undo_conflict')] : [])]
        if (parts.length > 0) report(r.failed.length > 0 || r.conflicts.length > 0, parts.join(' '))
        else {
          stopTimer()
          setUndo(null)
        }
      },
      () => {
        setBusy(false)
        report(true, errorText(t, 'unknown'))
      }
    )
  }

  const element = undo ? (
    <div className="toast" role="status">
      <span>{undo.text}</span>
      <button className="small" disabled={busy} onClick={revert}>
        {t('trash.undo')}
      </button>
    </div>
  ) : notice ? (
    <div className={`toast${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>
      {notice.text}
    </div>
  ) : null
  return { show, element }
}
