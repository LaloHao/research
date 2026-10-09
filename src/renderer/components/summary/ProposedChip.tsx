import { useTranslation } from 'react-i18next'
import type { RunAction } from './FieldCard'

/** A value the model proposed outside the form; accepting or mapping it applies to every paper. */
export function ProposedChip({ facetKey, value, allowed, run }: { facetKey: string; value: string; allowed: string[]; run: RunAction }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="row small proposed" title={t('summary.applies_to_all')}>
      <span className="chip chip-proposed">{t('summary.proposed', { value })}</span>
      <button className="small" onClick={() => void run(() => window.research.summary.acceptProposed(facetKey, value))}>
        {t('summary.accept')}
      </button>
      <select
        className="small"
        value=""
        onChange={(e) => {
          const to = e.target.value
          if (to) void run(() => window.research.summary.mapProposed(facetKey, value, to))
        }}
      >
        <option value="">{t('summary.map_to')}</option>
        {allowed.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  )
}
