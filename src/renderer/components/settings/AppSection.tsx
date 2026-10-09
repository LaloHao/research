import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AppSection({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')

  useEffect(() => {
    void window.research.settings.get().then((s) => setEmail(s.contactEmail))
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
      <button onClick={() => void window.research.project.close()}>{t('settings.close_project')}</button>
    </section>
  )
}
