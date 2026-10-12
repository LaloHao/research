import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings } from '../../../shared/settings'
import { errorText } from '../../lib/errorText'
import { parseSyncMinutes } from '../../lib/sync'
import { ModelsSection } from './ModelsSection'

type SettingsPatch = Parameters<typeof window.research.settings.set>[0]
type Field = 'contactEmail' | 'openalexApiKey' | 'autoSync' | 'autoSyncMinutes'

export function AppSection({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [email, setEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [autoSync, setAutoSync] = useState(true)
  const [minutes, setMinutes] = useState('')
  const [savedMinutes, setSavedMinutes] = useState<number | null>(null)
  const [minutesIssue, setMinutesIssue] = useState<string | null>(null)
  // A failed save per field: another field's success never hides it.
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  // Per field, only the latest save's answer counts; the main process applies them in order.
  const requests = useRef<Partial<Record<Field, number>>>({})
  // The last «Sincronizar automáticamente» the main process confirmed, to go back to when a save fails.
  const savedAutoSync = useRef(true)

  useEffect(() => {
    window.research.settings.get().then(
      (s) => {
        setEmail(s.contactEmail)
        setApiKey(s.openalexApiKey)
        setAutoSync(s.autoSync)
        savedAutoSync.current = s.autoSync
        setMinutes(String(s.autoSyncMinutes))
        setSavedMinutes(s.autoSyncMinutes)
        setLoaded(true)
      },
      () => setLoadError(errorText(t, 'unknown'))
    )
  }, [t])

  const save = (field: Field, patch: SettingsPatch, outcome: { applied?: (s: AppSettings, latest: boolean) => void; failed?: () => void } = {}): void => {
    const token = (requests.current[field] ?? 0) + 1
    requests.current[field] = token
    const latest = (): boolean => requests.current[field] === token
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    window.research.settings.set(patch).then(
      (s) => {
        outcome.applied?.(s, latest())
        if (latest()) onSaved()
      },
      () => {
        if (!latest()) return
        outcome.failed?.()
        setErrors((current) => ({ ...current, [field]: errorText(t, 'unknown') }))
      }
    )
  }

  const saveAutoSync = (value: boolean): void => {
    setAutoSync(value)
    save(
      'autoSync',
      { autoSync: value },
      {
        applied: (s, latest) => {
          savedAutoSync.current = s.autoSync
          if (latest) setAutoSync(s.autoSync)
        },
        failed: () => setAutoSync(savedAutoSync.current)
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
    save('autoSyncMinutes', { autoSyncMinutes: parsed.value }, { applied: (s) => setSavedMinutes(s.autoSyncMinutes) })
  }

  const shownError = loadError ?? Object.values(errors).find(Boolean) ?? null
  const [logsError, setLogsError] = useState<string | null>(null)
  const [openingLogs, setOpeningLogs] = useState(false)

  const openLogs = (): void => {
    if (openingLogs) return
    setLogsError(null)
    setOpeningLogs(true)
    window.research.app.openLogs().then(
      (r) => {
        setOpeningLogs(false)
        setLogsError(r.ok ? null : errorText(t, r.error))
      },
      () => {
        setOpeningLogs(false)
        setLogsError(errorText(t, 'unknown'))
      }
    )
  }

  return (
    <section>
      <label className="field">
        <span>{t('settings.contact_email')}</span>
        <input type="email" value={email} disabled={!loaded} onChange={(e) => setEmail(e.target.value)} onBlur={() => save('contactEmail', { contactEmail: email.trim() })} />
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
          onBlur={() => save('openalexApiKey', { openalexApiKey: apiKey.trim() })}
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
            onChange={(e) => saveAutoSync(e.target.checked)}
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
      {shownError && (
        <p className="field-error" role="alert">
          {shownError}
        </p>
      )}
      <ModelsSection />
      <h3>{t('settings.logs')}</h3>
      <div className="field">
        <button type="button" disabled={openingLogs} onClick={openLogs}>
          {t('settings.open_logs')}
        </button>
        <small className="muted">{t('settings.logs_help')}</small>
        {logsError && (
          <p className="field-error" role="alert">
            {logsError}
          </p>
        )}
      </div>
      <button onClick={() => void window.research.project.close()}>{t('settings.close_project')}</button>
    </section>
  )
}
