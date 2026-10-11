import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings } from '../../../shared/settings'
import { errorText } from '../../lib/errorText'
import { parseSyncMinutes } from '../../lib/sync'
import { ModelsSection } from './ModelsSection'

type SettingsPatch = Parameters<typeof window.research.settings.set>[0]

export function AppSection({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [email, setEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [autoSync, setAutoSync] = useState(true)
  const [minutes, setMinutes] = useState('')
  const [savedMinutes, setSavedMinutes] = useState<number | null>(null)
  const [minutesIssue, setMinutesIssue] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the latest save's answer shows (a failure or «Guardado»); the main process applies them in order.
  const request = useRef(0)

  useEffect(() => {
    window.research.settings.get().then(
      (s) => {
        setEmail(s.contactEmail)
        setApiKey(s.openalexApiKey)
        setAutoSync(s.autoSync)
        setMinutes(String(s.autoSyncMinutes))
        setSavedMinutes(s.autoSyncMinutes)
        setLoaded(true)
      },
      () => setError(errorText(t, 'unknown'))
    )
  }, [t])

  const save = (patch: SettingsPatch, applied?: (s: AppSettings) => void): void => {
    const token = ++request.current
    setError(null)
    window.research.settings.set(patch).then(
      (s) => {
        applied?.(s)
        if (token === request.current) onSaved()
      },
      () => {
        if (token === request.current) setError(errorText(t, 'unknown'))
      }
    )
  }

  const saveMinutes = (): void => {
    const parsed = parseSyncMinutes(minutes)
    if (!parsed.ok) {
      setMinutesIssue(parsed.issue === 'out_of_range' ? t('sync.auto.minutes_help') : t(`settings.invalid.${parsed.issue}`))
      return
    }
    setMinutesIssue(null)
    setMinutes(String(parsed.value))
    if (parsed.value === savedMinutes) return
    save({ autoSyncMinutes: parsed.value }, (s) => setSavedMinutes(s.autoSyncMinutes))
  }

  return (
    <section>
      <label className="field">
        <span>{t('settings.contact_email')}</span>
        <input type="email" value={email} disabled={!loaded} onChange={(e) => setEmail(e.target.value)} onBlur={() => save({ contactEmail: email.trim() })} />
        <small className="muted">{t('settings.contact_email_help')}</small>
      </label>
      <label className="field">
        <span>{t('settings.openalex_key')}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={!loaded}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={() => save({ openalexApiKey: apiKey.trim() })}
        />
        <small className="muted">{t('settings.openalex_key_help')}</small>
      </label>
      <h3>{t('sync.auto.title')}</h3>
      <div className="field">
        <label className="row">
          <input
            type="checkbox"
            checked={autoSync}
            disabled={!loaded}
            onChange={(e) => {
              setAutoSync(e.target.checked)
              save({ autoSync: e.target.checked })
            }}
          />
          {t('sync.auto.enabled')}
        </label>
        <small className="muted">{t('sync.auto.enabled_help')}</small>
      </div>
      <label className="field">
        <span>{t('sync.auto.minutes')}</span>
        <input
          inputMode="numeric"
          value={minutes}
          disabled={!loaded || !autoSync}
          aria-invalid={minutesIssue !== null}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={saveMinutes}
        />
        {minutesIssue ? <small className="field-error">{minutesIssue}</small> : <small className="muted">{t('sync.auto.minutes_help')}</small>}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <ModelsSection />
      <button onClick={() => void window.research.project.close()}>{t('settings.close_project')}</button>
    </section>
  )
}
