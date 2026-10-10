import { useTranslation } from 'react-i18next'
import type { FacetFilter } from '../../../shared/relations'
import { MAP_TABS, type MapTab } from '../../lib/navigation'
import { CandidatesTab } from './CandidatesTab'
import { ChartsTab } from './ChartsTab'
import { GraphTab } from './GraphTab'

export function MapView({
  tab,
  onTabChange,
  visibleIds,
  candidatesPaper,
  onClearCandidatesPaper,
  onOpenLibrary,
  onOpenCandidates
}: {
  tab: MapTab
  onTabChange: (tab: MapTab) => void
  visibleIds: string[] | null
  candidatesPaper: string | null
  onClearCandidatesPaper: () => void
  onOpenLibrary: (filters: FacetFilter[]) => void
  onOpenCandidates: (paperId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="map-view">
      <nav className="tabs" role="tablist">
        {MAP_TABS.map((id) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => onTabChange(id)}>
            {t(`map.tabs.${id}`)}
          </button>
        ))}
      </nav>
      <div className="map-body">
        {tab === 'graph' && <GraphTab visibleIds={visibleIds} onOpenCandidates={onOpenCandidates} />}
        {tab === 'charts' && <ChartsTab onOpenLibrary={onOpenLibrary} />}
        {tab === 'candidates' && <CandidatesTab paperId={candidatesPaper} onClearPaper={onClearCandidatesPaper} />}
      </div>
    </div>
  )
}
