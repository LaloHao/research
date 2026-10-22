import { useId } from 'react'
import { useTranslation } from 'react-i18next'

/** A Claude feature of «Redacción» that is not here yet: its button, disabled, with «Disponible pronto». */
export function ComingSoon({ label }: { label: string }): React.JSX.Element {
  const { t } = useTranslation()
  const note = useId()
  return (
    <div className="writing-coming-soon row">
      <button disabled aria-describedby={note}>
        {label}
      </button>
      <span id={note} className="muted small">
        {t('writing.coming_soon')}
      </span>
    </div>
  )
}
