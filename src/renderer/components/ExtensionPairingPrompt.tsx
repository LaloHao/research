import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PairingRequest } from '../../shared/extension'

/**
 * «¿Vincular la extensión de Firefox?»: asked once the browser extension sent the code Settings showed. Only
 * «Aceptar» pairs it (a local program that read the code still needs this click). Mounted outside the project shell:
 * the extension waits for the answer whatever view is open.
 */
export function ExtensionPairingPrompt(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [request, setRequest] = useState<PairingRequest | null>(null)

  useEffect(() => {
    // A question that was already waiting when the window (re)loaded.
    window.research.extension.pendingPairing().then(
      (pending) => setRequest((current) => current ?? pending),
      () => undefined
    )
    return window.research.extension.onPairingRequest(setRequest)
  }, [])

  if (!request) return null
  const answer = (accepted: boolean): void => {
    const id = request.id
    setRequest(null)
    void window.research.extension.answerPairing(id, accepted).catch(() => undefined)
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="extension-pairing-title"
        aria-describedby="extension-pairing-text"
        onKeyDown={(e) => {
          if (e.key === 'Escape') answer(false)
        }}
      >
        <h3 id="extension-pairing-title">{t('extension.confirm.title', { browser: t(`extension.browsers.${request.browser}`) })}</h3>
        <p id="extension-pairing-text">{t('extension.confirm.body')}</p>
        <p className="muted small">
          <code>{request.origin}</code>
        </p>
        <div className="row">
          <button className="primary" onClick={() => answer(true)}>
            {t('extension.confirm.accept')}
          </button>
          <button autoFocus onClick={() => answer(false)}>
            {t('extension.confirm.reject')}
          </button>
        </div>
      </div>
    </div>
  )
}
