import { useTranslation } from 'react-i18next'
import type { View } from '../lib/navigation'

const ITEMS: { view: View; icon: string }[] = [
  { view: 'library', icon: '📚' },
  { view: 'map', icon: '🕸' },
  { view: 'settings', icon: '⚙' }
]

export function Rail({ view, onSelect }: { view: View; onSelect: (view: View) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <nav className="rail">
      {ITEMS.map((item) => (
        <button
          key={item.view}
          className={`rail-item${item.view === view ? ' active' : ''}`}
          title={t(`rail.${item.view}`)}
          aria-label={t(`rail.${item.view}`)}
          aria-current={item.view === view ? 'page' : undefined}
          onClick={() => onSelect(item.view)}
        >
          {item.icon}
        </button>
      ))}
    </nav>
  )
}
