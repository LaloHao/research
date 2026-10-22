import { useTranslation } from 'react-i18next'
import { ComingSoon } from './ComingSoon'

/** «Borrador»: a section drafted by Claude with verified citations. Placeholder until the draft task lands. */
export function DraftTab(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="writing-tab narrow">
      <h3>{t('writing.draft.title')}</h3>
      <p className="muted">{t('writing.draft.intro')}</p>
      <ComingSoon label={t('writing.draft.run')} />
    </section>
  )
}
