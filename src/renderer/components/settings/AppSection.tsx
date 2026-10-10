import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModelsSection } from './ModelsSection'

export function AppSection({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    void window.research.settings.get().then((s) => {
      setEmail(s.contactEmail)
      setApiKey(s.openalexApiKey)
    })
  }, [])

  return (
    <section>
      <label className="field">
        <span>{t('settings.contact_email')}</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => void window.research.settings.set({ contactEmail: email.trim() }).then(onSaved)}
        />
        <small className="muted">{t('settings.contact_email_help')}</small>
      </label>
      <label className="field">
        <span>{t('settings.openalex_key')}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onBlur={() => void window.research.settings.set({ openalexApiKey: apiKey.trim() }).then(onSaved)}
        />
        <small className="muted">{t('settings.openalex_key_help')}</small>
      </label>
      <ModelsSection />
      <button onClick={() => void window.research.project.close()}>{t('settings.close_project')}</button>
    </section>
  )
}
