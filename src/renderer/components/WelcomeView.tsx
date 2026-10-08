import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectOpenResult } from '../../shared/ipc'
import { errorText } from '../lib/errorText'

export function WelcomeView(): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = (action: () => Promise<ProjectOpenResult>): void => {
    setError(null)
    action()
      .then((result) => {
        if (!result.ok) setError(errorText(t, result.error))
      })
      .catch(() => setError(errorText(t, 'unknown')))
  }

  return (
    <div className="welcome">
      <h1>{t('welcome.title')}</h1>
      <p className="muted">{t('welcome.subtitle')}</p>
      <label className="field">
        <span>{t('welcome.name_label')}</span>
        <input value={name} placeholder={t('welcome.name_placeholder')} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row">
        <button className="primary" disabled={!name.trim()} onClick={() => run(() => window.research.project.create(name.trim()))}>
          {t('welcome.create')}
        </button>
        <button onClick={() => run(() => window.research.project.open())}>{t('welcome.open')}</button>
      </div>
      {error && <p className="error">{t('welcome.error', { message: error })}</p>}
    </div>
  )
}
