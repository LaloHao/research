import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from '../shared/ipc'
import type { FacetFilter } from '../shared/relations'
import { LibraryView } from './components/library/LibraryView'
import { MapView } from './components/map/MapView'
import { Rail } from './components/Rail'
import { RelationsFileBanner } from './components/RelationsFileBanner'
import { SettingsView } from './components/SettingsView'
import { SyncView } from './components/sync/SyncView'
import { TrashView } from './components/TrashView'
import { WelcomeView } from './components/WelcomeView'
import { useEvent } from './hooks/useEvent'
import { useSyncStatus } from './hooks/useSyncStatus'
import { flushAll } from './lib/flush'
import type { MapTab, View } from './lib/navigation'

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined)
  const [view, setView] = useState<View>('library')

  const refresh = useCallback(() => {
    void window.research.project.current().then(setProject)
  }, [])
  useEffect(refresh, [refresh])
  useEvent('project-changed', refresh)
  useEvent('flush-request', () => {
    void flushAll().finally(() => window.research.flushDone())
  })

  if (project === undefined) return <div className="center muted">{t('app.loading')}</div>
  if (project === null) return <WelcomeView />
  // Keyed by the project folder: filters, visible rows and the candidates' paper of one project never reach the next.
  return <ProjectShell key={project.root} project={project} view={view} onViewChange={setView} />
}

interface ProjectShellProps {
  project: ProjectInfo
  view: View
  onViewChange: (view: View) => void
}

/** Everything whose state belongs to the open project. */
function ProjectShell({ project, view, onViewChange: setView }: ProjectShellProps): React.JSX.Element {
  const [mapTab, setMapTab] = useState<MapTab>('graph')
  const [candidatesPaper, setCandidatesPaper] = useState<string | null>(null)
  const [facetFilters, setFacetFilters] = useState<FacetFilter[]>([])
  // The library's last visible rows, for the graph's "apply the library's filters"; null until the library is shown.
  const [visibleIds, setVisibleIds] = useState<string[] | null>(null)
  const sync = useSyncStatus()
  const refreshSync = sync.refresh
  const [syncing, setSyncing] = useState(false)

  const openLibrary = useCallback(
    (filters: FacetFilter[]) => {
      setFacetFilters(filters)
      setView('library')
    },
    [setView]
  )
  const clearCandidatesPaper = useCallback(() => setCandidatesPaper(null), [])
  const openCandidates = useCallback(
    (paperId: string) => {
      setCandidatesPaper(paperId)
      setMapTab('candidates')
      setView('map')
    },
    [setView]
  )
  // The rail's «Sincronizar»: when it ends in conflicts or an error, the Sync view explains it. The automatic sync never switches views.
  const runSync = useCallback(() => {
    if (syncing) return
    setSyncing(true)
    window.research.sync.run().then(
      (result) => {
        setSyncing(false)
        refreshSync()
        if (!result.ok || result.outcome === 'conflicts') setView('sync')
      },
      () => {
        setSyncing(false)
        refreshSync()
        setView('sync')
      }
    )
  }, [syncing, refreshSync, setView])

  return (
    <div className="shell">
      <Rail view={view} onSelect={setView} sync={sync} syncing={syncing} onSync={runSync} />
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
        {view === 'trash' && <TrashView />}
        {view === 'sync' && <SyncView sync={sync} />}
        {view === 'settings' && <SettingsView project={project} />}
      </main>
      <RelationsFileBanner />
    </div>
  )
}
