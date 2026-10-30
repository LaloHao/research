import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DesktopStatus } from '../../../shared/desktop'
import { errorText } from '../../lib/errorText'

type Flag = 'closeToTray' | 'startHidden'

/** «Bandeja y arranque»: closing to the tray, starting hidden, and «Iniciar con la sesión». */
export function TraySection({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [flags, setFlags] = useState<Record<Flag, boolean> | null>(null)
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.research.settings.get().then(
      (s) => setFlags({ closeToTray: s.closeToTray, startHidden: s.startHidden }),
      () => setError(errorText(t, 'unknown'))
    )
    window.research.app.desktopStatus().then(setDesktop, () => setError(errorText(t, 'unknown')))
  }, [t])
  useEffect(refresh, [refresh])

  const saveFlag = (flag: Flag, value: boolean): void => {
    setError(null)
    setFlags((current) => (current ? { ...current, [flag]: value } : current))
    window.research.settings.set({ [flag]: value }).then(
      (s) => {
        setFlags({ closeToTray: s.closeToTray, startHidden: s.startHidden })
        onSaved()
      },
      () => {
        setError(errorText(t, 'unknown'))
        refresh()
      }
    )
  }

  const saveAutostart = (enabled: boolean): void => {
    setBusy(true)
    setError(null)
    window.research.app.setAutostart(enabled).then(
      (status) => {
        setBusy(false)
        setDesktop(status)
        onSaved()
      },
      () => {
        setBusy(false)
        setError(t('tray.settings.autostart_failed'))
        refresh()
      }
    )
  }

  const autostart = desktop?.autostart
  return (
    <>
      <h3>{t('tray.settings.title')}</h3>
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={flags?.closeToTray ?? false} disabled={!flags} onChange={(e) => saveFlag('closeToTray', e.target.checked)} />
          {t('tray.settings.close_to_tray')}
        </label>
        <small className="muted">{t('tray.settings.close_to_tray_help')}</small>
        {desktop && !desktop.trayAvailable && <small className="field-error">{t('tray.settings.tray_unavailable')}</small>}
      </div>
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={flags?.startHidden ?? false} disabled={!flags} onChange={(e) => saveFlag('startHidden', e.target.checked)} />
          {t('tray.settings.start_hidden')}
        </label>
        <small className="muted">{t('tray.settings.start_hidden_help')}</small>
      </div>
      <div className="field">
        <label className="row">
          <input
            type="checkbox"
            checked={autostart?.enabled ?? false}
            // Turning it off stays possible even where it could not be turned on (an entry written by a packaged build).
            disabled={busy || !autostart || !autostart.supported || (!autostart.packaged && !autostart.enabled)}
            onChange={(e) => saveAutostart(e.target.checked)}
          />
          {t('tray.settings.autostart')}
        </label>
        {autostart && !autostart.supported && <small className="muted">{t('tray.settings.autostart_unsupported')}</small>}
        {autostart?.supported && autostart.packaged && <small className="muted">{t('tray.settings.autostart_help', { file: autostart.file })}</small>}
        {autostart?.supported && !autostart.packaged && (
          <>
            <small className="muted">{t('tray.settings.autostart_dev')}</small>
            {autostart.devCommand && <code className="small">{autostart.devCommand}</code>}
          </>
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
