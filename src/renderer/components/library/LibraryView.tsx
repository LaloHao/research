import { useTranslation } from 'react-i18next'

export function LibraryView(): React.JSX.Element {
  const { t } = useTranslation()
  return <div className="center muted">{t('library.empty')}</div>
}
