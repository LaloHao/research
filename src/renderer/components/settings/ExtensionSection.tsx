import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionStatus } from '../../../shared/extension'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

/** The code as Settings shows it: two groups of four, easier to type. */
const grouped = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * «Extensión del navegador»: «Vincular extensión» shows a one-time code (five minutes) to type in the extension's
 * options; the paired extensions are listed with «Revocar». Needs the local API to be listening.
 */
export function ExtensionSection(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<ExtensionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(() => {
    window.research.extension.status().then(setStatus, () => setError(errorText(t, 'unknown')))
  }, [t])
  useEffect(refresh, [refresh])
  useEvent('extensions-changed', refresh)
  // The API's switch is in the section above.
  useEvent('settings-changed', refresh)

  const code = status?.code ?? null
  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  const left = code ? Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now) / 1000)) : 0
  useEffect(() => {
    if (code && left === 0) refresh()
  }, [code, left, refresh])

  const start = (): void => {
    setError(null)
    window.research.extension.startPairing().then(refresh, () => setError(errorText(t, 'unknown')))
  }
  const cancel = (): void => void window.research.extension.cancelPairing().then(refresh, () => undefined)
  const revoke = (id: string): void => {
    if (!window.confirm(t('extension.revoke_confirm'))) return
    window.research.extension.revoke(id).then(refresh, () => setError(errorText(t, 'unknown')))
  }

  if (!status) return null
  const date = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language)
  return (
    <>
      <h3>{t('extension.title')}</h3>
      <p className="muted small">{t('extension.intro')}</p>
      {!status.apiRunning && <p className="muted small">{t('extension.needs_api')}</p>}
      <div className="field">
        {code && left > 0 ? (
          <>
            <p>
              {t('extension.code_label')} <strong className="pairing-code">{grouped(code.code)}</strong>
            </p>
            <small className="muted">{t('extension.code_help', { minutes: Math.floor(left / 60), seconds: String(left % 60).padStart(2, '0') })}</small>
            <div className="row">
              <button type="button" onClick={cancel}>
                {t('extension.cancel')}
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            <button type="button" disabled={!status.apiRunning} onClick={start}>
              {t('extension.pair')}
            </button>
          </div>
        )}
      </div>
      <div className="field">
        <span>{t('extension.paired')}</span>
        {status.paired.length === 0 ? (
          <small className="muted">{t('extension.none')}</small>
        ) : (
          <ul className="plain-list">
            {status.paired.map((p) => (
              <li key={p.id} className="row">
                <span>
                  {t(`extension.browsers.${p.browser}`)} · <small className="muted">{t('extension.since', { date: date(p.createdAt) })}</small>
                  {p.lastUsedAt && <small className="muted"> · {t('extension.last_used', { date: date(p.lastUsedAt) })}</small>}
                </span>
                <button type="button" className="small" onClick={() => revoke(p.id)}>
                  {t('extension.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
