import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { recaptureUrl } from '../../../shared/capture'
import { errorText } from '../../lib/errorText'

/**
 * «Volver a capturar desde la web»: opens the app's browser at the paper's URL (or its DOI) bound to the paper, so the
 * page captured there replaces its PDF. Nothing for a paper without either; the main process works out the address.
 */
export function RecaptureButton({ id, identifiers }: { id: string; identifiers: { url?: string | null; doi?: string | null } }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!recaptureUrl(identifiers)) return null
  const open = (): void => {
    setBusy(true)
    setError(null)
    window.research.library.recapture(id).then(
      (result) => {
        setBusy(false)
        if (!result.ok) setError(errorText(t, result.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }
  return (
    <>
      {error && <span className="error small">{error}</span>}
      <button className="small" disabled={busy} title={t('paper.recapture_hint')} onClick={open}>
        {t('paper.recapture')}
      </button>
    </>
  )
}
