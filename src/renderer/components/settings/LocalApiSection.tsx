import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_PORTS, type LocalApiStatus } from '../../../shared/localApi'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'

type Patch = Parameters<typeof window.research.settings.set>[0]
type Notice = { error: boolean; text: string }

/** «API local»: the switch, the port, the token buttons and «Permitir operaciones con costo desde la API». */
export function LocalApiSection({ onSaved }: { onSaved: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<LocalApiStatus | null>(null)
  const [port, setPort] = useState('')
  const [portIssue, setPortIssue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const refresh = useCallback(() => {
    window.research.localApi.status().then(
      (s) => {
        setStatus(s)
        if (s) setPort(String(s.port))
      },
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }, [t])
  useEffect(refresh, [refresh])
  // The tray turns the API on and off too.
  useEvent('settings-changed', refresh)

  const save = (patch: Patch): void => {
    setBusy(true)
    setNotice(null)
    window.research.settings.set(patch).then(
      () => {
        setBusy(false)
        onSaved()
        refresh()
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
        refresh()
      }
    )
  }

  const savePort = (): void => {
    const value = Number(port.trim())
    if (!Number.isInteger(value) || value < API_PORTS.min || value > API_PORTS.max) {
      setPortIssue(true)
      return
    }
    setPortIssue(false)
    if (status && value !== status.port) save({ apiPort: value })
  }

  const copyToken = (): void => {
    window.research.localApi.copyToken().then(
      (copied) => setNotice(copied ? { error: false, text: t('local_api.copied') } : { error: true, text: t('local_api.no_token') }),
      () => setNotice({ error: true, text: errorText(t, 'unknown') })
    )
  }

  const regenerate = (): void => {
    if (!window.confirm(t('local_api.regenerate_confirm'))) return
    setBusy(true)
    window.research.localApi.regenerateToken().then(
      (s) => {
        setBusy(false)
        setStatus(s)
        setNotice({ error: false, text: t('local_api.regenerated') })
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  // The app runs without the API only in tests.
  if (!status) return null
  return (
    <>
      <h3>{t('local_api.title')}</h3>
      <p className="muted small">{t('local_api.intro')}</p>
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => save({ apiEnabled: e.target.checked })} />
          {t('local_api.enabled')}
        </label>
        {status.enabled && (
          <small className={status.error ? 'field-error' : 'muted'} role={status.error ? 'alert' : undefined}>
            {status.error
              ? t(`local_api.errors.${status.error}`, { port: status.port })
              : status.running && status.url
                ? t('local_api.state.running', { url: status.url })
                : t('local_api.state.stopped')}
          </small>
        )}
      </div>
      <label className="field">
        <span>{t('local_api.port')}</span>
        <input inputMode="numeric" value={port} disabled={busy} aria-invalid={portIssue} onChange={(e) => setPort(e.target.value)} onBlur={savePort} />
        <small className={portIssue ? 'field-error' : 'muted'}>{t(portIssue ? 'local_api.port_invalid' : 'local_api.port_help', API_PORTS)}</small>
      </label>
      {status.enabled && (
        <div className="field">
          <div className="row">
            <button type="button" onClick={copyToken}>
              {t('local_api.copy_token')}
            </button>
            <button type="button" disabled={busy} onClick={regenerate}>
              {t('local_api.regenerate')}
            </button>
          </div>
          <small className="muted">{t('local_api.file', { file: status.file })}</small>
        </div>
      )}
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={status.allowCostly} disabled={busy} onChange={(e) => save({ apiAllowCostly: e.target.checked })} />
          {t('local_api.allow_costly')}
        </label>
        <small className="muted">{t('local_api.allow_costly_help')}</small>
      </div>
      {notice && (
        <p className={notice.error ? 'field-error' : 'muted small'} role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
    </>
  )
}
