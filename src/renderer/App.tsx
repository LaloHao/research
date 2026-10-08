import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from '../shared/ipc'
import { LibraryView } from './components/library/LibraryView'
import { Rail, type View } from './components/Rail'
import { SettingsView } from './components/SettingsView'
import { WelcomeView } from './components/WelcomeView'
import { useEvent } from './hooks/useEvent'

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined)
  const [view, setView] = useState<View>('library')

  const refresh = useCallback(() => {
    void window.research.project.current().then(setProject)
  }, [])
  useEffect(refresh, [refresh])
  useEvent('project-changed', refresh)

  if (project === undefined) return <div className="center muted">{t('app.loading')}</div>
  if (project === null) return <WelcomeView />
  return (
    <div className="shell">
      <Rail view={view} onSelect={setView} />
      <main className="view">{view === 'library' ? <LibraryView /> : <SettingsView project={project} />}</main>
    </div>
  )
}
