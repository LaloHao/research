import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from '../shared/ipc'
import type { FacetFilter } from '../shared/relations'
import { LibraryView } from './components/library/LibraryView'
import { MapView } from './components/map/MapView'
import { Rail } from './components/Rail'
import { SettingsView } from './components/SettingsView'
import { WelcomeView } from './components/WelcomeView'
import { useEvent } from './hooks/useEvent'
import { flushAll } from './lib/flush'
import type { MapTab, View } from './lib/navigation'

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined)
  const [view, setView] = useState<View>('library')
  const [mapTab, setMapTab] = useState<MapTab>('graph')
  const [candidatesPaper, setCandidatesPaper] = useState<string | null>(null)
  const [facetFilters, setFacetFilters] = useState<FacetFilter[]>([])
  // The library's last visible rows, for the graph's "apply the library's filters"; null until the library is shown.
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null)

  const refresh = useCallback(() => {
    void window.research.project.current().then(setProject)
  }, [])
  useEffect(refresh, [refresh])
  useEvent('project-changed', refresh)
  useEvent('flush-request', () => {
    void flushAll().finally(() => window.research.flushDone())
  })

  const openLibrary = useCallback((filters: FacetFilter[]) => {
    setFacetFilters(filters)
    setView('library')
  }, [])
  const clearCandidatesPaper = useCallback(() => setCandidatesPaper(null), [])
  const openCandidates = useCallback((paperId: string) => {
    setCandidatesPaper(paperId)
    setMapTab('candidates')
    setView('map')
  }, [])

  if (project === undefined) return <div className="center muted">{t('app.loading')}</div>
  if (project === null) return <WelcomeView />
  return (
    <div className="shell">
      <Rail view={view} onSelect={setView} />
      <main className="view">
        {view === 'library' && (
          <LibraryView facetFilters={facetFilters} onFacetFiltersChange={setFacetFilters} onVisibleChange={setVisibleIds} onOpenCandidates={openCandidates} />
        )}
        {view === 'map' && (
          <MapView
            tab={mapTab}
            onTabChange={setMapTab}
            visibleIds={visibleIds}
            candidatesPaper={candidatesPaper}
            onClearCandidatesPaper={clearCandidatesPaper}
            onOpenLibrary={openLibrary}
            onOpenCandidates={openCandidates}
          />
        )}
        {view === 'settings' && <SettingsView project={project} />}
      </main>
    </div>
  )
}
