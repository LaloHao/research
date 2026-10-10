import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { ModelInfo } from '../../../shared/relations'
import { useEvent } from '../../hooks/useEvent'
import { formatBytes } from '../../lib/bytes'
import { errorText } from '../../lib/errorText'

export function ModelsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [info, setInfo] = useState<ModelInfo | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.research.models.info().then(setInfo, () => undefined)
  }, [])
  useEffect(refresh, [refresh])
  useEvent('jobs-changed', refresh)

  const act = (action: Promise<ActionResult>): void => {
    void action.then((result) => {
      setError(result.ok ? null : errorText(t, result.error))
      setConfirmRemove(false)
      refresh()
    })
  }

  if (!info) return null
  return (
    <section className="models">
      <h3>{t('settings.local_models.title')}</h3>
      <p className="muted small">{t('settings.local_models.help')}</p>
      {!info.available ? (
        <p className="muted">{t('settings.local_models.unavailable')}</p>
      ) : (
        <>
          <p>
            <code>{info.modelId}</code> · {info.downloading ? t('settings.local_models.downloading') : t(`settings.local_models.state.${info.state}`)}
            {info.sizeBytes > 0 ? ` · ${formatBytes(info.sizeBytes)}` : ''}
          </p>
          <div className="row">
            {info.state === 'missing' && !info.downloading && <button onClick={() => act(window.research.models.download())}>{t('settings.local_models.download')}</button>}
            {info.state === 'ready' && !confirmRemove && <button onClick={() => setConfirmRemove(true)}>{t('settings.local_models.remove')}</button>}
            {confirmRemove && (
              <>
                <span>{t('settings.local_models.remove_confirm')}</span>
                <button className="primary" onClick={() => act(window.research.models.remove())}>
                  {t('settings.local_models.remove')}
                </button>
                <button onClick={() => setConfirmRemove(false)}>{t('settings.local_models.cancel')}</button>
              </>
            )}
          </div>
        </>
      )}
      {error && <div className="banner error">{error}</div>}
    </section>
  )
}
