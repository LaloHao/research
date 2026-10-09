import { useTranslation } from 'react-i18next'
import type { PaperRow } from '../../../shared/library'
import { rowBadges } from '../../lib/badges'

export function PaperList({
  rows,
  query,
  selected,
  onSelect
}: {
  rows: PaperRow[]
  query: string
  selected: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return <p className="muted pad">{query.trim() ? t('library.no_results', { query }) : t('library.empty')}</p>
  }
  return (
    <>
      <div className="muted small pad">{t('library.count', { count: rows.length })}</div>
      <ul className="paper-list">
        {rows.map((row) => (
          <li key={row.id}>
            <button className={`paper-row${row.id === selected ? ' selected' : ''}`} onClick={() => onSelect(row.id)}>
              <span className="paper-title">{row.title}</span>
              <span className="muted small">{[row.authors_label, row.year].filter(Boolean).join(' · ')}</span>
              <span className="badges">
                {rowBadges(row).map((badge) => (
                  <span key={badge} className={`badge badge-${badge}`}>
                    {t(`badges.${badge}`, badge === 'to_review' ? { count: row.pending_review } : undefined)}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
