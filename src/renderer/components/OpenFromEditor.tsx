import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperDetail } from '../../shared/library'
import { EvidencePanel, type Picked } from './review/EvidencePanel'

/**
 * The local API's `open_in_app` (an editor's «abrir en la app»): the paper at the page, the quote highlighted, over
 * whatever view is open. A later request replaces it; an unknown paper (removed meanwhile) shows nothing.
 */
export function OpenFromEditor(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [shown, setShown] = useState<{ detail: PaperDetail; picked: Picked | null } | null>(null)
  const seq = useRef(0)

  useEffect(
    () =>
      window.research.localApi.onOpenPaper((request) => {
        const token = ++seq.current
        window.research.library.detail(request.paper).then(
          (detail) => {
            if (token !== seq.current) return
            const picked = request.page !== null || request.quote ? { page: request.page, quote: request.quote ?? '' } : null
            setShown({ detail, picked })
          },
          () => undefined
        )
      }),
    []
  )

  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShown(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])

  if (!shown) return null
  return (
    <div className="modal-backdrop" onClick={() => setShown(null)}>
      <div className="modal editor-paper" role="dialog" aria-modal="true" aria-label={t('local_api.opened')} onClick={(e) => e.stopPropagation()}>
        <div className="row chat-evidence-head">
          <div>
            <small className="muted">{t('local_api.opened')}</small>
            <br />
            <strong>{shown.detail.paper?.title ?? shown.detail.id}</strong>
          </div>
          <button className="small" onClick={() => setShown(null)}>
            {t('local_api.close')}
          </button>
        </div>
        <div className="editor-paper-body">
          <EvidencePanel detail={shown.detail} evidence={shown.picked} />
        </div>
      </div>
    </div>
  )
}
