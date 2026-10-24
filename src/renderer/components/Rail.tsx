import { useTranslation } from 'react-i18next'
import type { SyncState } from '../hooks/useSyncStatus'
import type { View } from '../lib/navigation'
import { railAction, syncIndicator } from '../lib/sync'

const ITEMS: { view: View; icon: string }[] = [
  { view: 'library', icon: '📚' },
  { view: 'map', icon: '🕸' },
  { view: 'mappings', icon: '📋' },
  { view: 'chat', icon: '💬' },
  { view: 'writing', icon: '✍️' },
  { view: 'trash', icon: '🗑' }
]

interface RailProps {
  view: View
  onSelect: (view: View) => void
  sync: SyncState
  /** A «Sincronizar» started from the rail is in flight. */
  syncing: boolean
  onSync: () => void
}

export function Rail({ view, onSelect, sync, syncing, onSync }: RailProps): React.JSX.Element {
  const { t } = useTranslation()
  const indicator = syncIndicator(sync.status, sync.now)
  const full = t(`sync.status.${indicator.state}`, { count: indicator.count })
  const action = railAction(sync.status)
  const short = t(`sync.short.${indicator.state}`, { count: indicator.count })

  const item = (v: View, icon: string): React.JSX.Element => (
    <button
      key={v}
      className={`rail-item${v === view ? ' active' : ''}`}
      title={t(`rail.${v}`)}
      aria-label={t(`rail.${v}`)}
      aria-current={v === view ? 'page' : undefined}
      onClick={() => onSelect(v)}
    >
      {icon}
    </button>
  )

  return (
    <nav className="rail">
      {ITEMS.map((i) => item(i.view, i.icon))}
      {/* «Sincronizar» and its status: a short line under the button, the full status as its tooltip. */}
      <div className={`rail-sync tone-${indicator.tone}${view === 'sync' ? ' active' : ''}`}>
        <button
          className="rail-item"
          title={t('sync.rail_title', { status: full })}
          aria-label={t('sync.rail_title', { status: full })}
          disabled={syncing || action === 'none'}
          onClick={() => (action === 'sync' ? onSync() : onSelect('sync'))}
        >
          ⟳
        </button>
        <button
          className="link rail-sync-label"
          title={full}
          // The visible short status is part of the name (WCAG 2.5.3); the full one is the tooltip.
          aria-label={`${t('rail.sync')}: ${short}`}
          aria-current={view === 'sync' ? 'page' : undefined}
          onClick={() => onSelect('sync')}
        >
          {short}
        </button>
      </div>
      {item('settings', '⚙')}
    </nav>
  )
}
