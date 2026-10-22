import { useTranslation } from 'react-i18next'
import { ComingSoon } from './ComingSoon'

/** «Estilo»: Claude's style suggestions for pasted text. Placeholder until the style task lands. */
export function StyleTab(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="writing-tab narrow">
      <h3>{t('writing.style.title')}</h3>
      <p className="muted">{t('writing.style.intro')}</p>
      <ComingSoon label={t('writing.style.run')} />
    </section>
  )
}
