import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'

/** «Quitar de la biblioteca», after a confirmation naming the paper; its folder goes to the trash, nothing is deleted. */
export function RemovePaper({ id, title, onRemoved }: { id: string; title: string; onRemoved: (ids: string[]) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setConfirming(false)
    setError(null)
  }, [id])

  const remove = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.research.library.trash([id]).then(
      (r) => {
        setBusy(false)
        setConfirming(false)
        if (r.moved.length > 0) onRemoved(r.moved)
        if (r.error) setError(errorText(t, r.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }

  return (
    <>
      <div className="row small">
        <button className="small" disabled={busy || confirming} onClick={() => setConfirming(true)}>
          {t('paper.remove')}
        </button>
      </div>
      {confirming && (
        <div className="banner warning">
          <span>{t('paper.remove_confirm', { title })}</span>
          <button className="danger" disabled={busy} onClick={remove}>
            {t('paper.remove')}
          </button>
          <button disabled={busy} onClick={() => setConfirming(false)}>
            {t('jobs.cancel')}
          </button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
    </>
  )
}
