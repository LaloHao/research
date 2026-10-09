import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectInfo } from '../../shared/ipc'
import { nextTab, SETTINGS_TABS, type SettingsTab } from '../lib/settingsTabs'
import { AppSection } from './settings/AppSection'
import { ClaudeSection } from './settings/ClaudeSection'
import { ExtractionFormView } from './settings/ExtractionFormView'
import { ProjectSection } from './settings/ProjectSection'
import { ThesisSection } from './settings/ThesisSection'

const STORAGE_KEY = 'research.settings.tab'
const DEFAULT_TAB: SettingsTab = 'project'

function loadTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && (SETTINGS_TABS as readonly string[]).includes(stored)) return stored as SettingsTab
  } catch {
    // localStorage unavailable (e.g. private browsing); fall back to the default tab.
  }
  return DEFAULT_TAB
}

function saveTab(tab: SettingsTab): void {
  try {
    localStorage.setItem(STORAGE_KEY, tab)
  } catch {
    // ignore, this is just a convenience for the next visit
  }
}

export function SettingsView({ project }: { project: ProjectInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<SettingsTab>(loadTab)
  const [saved, setSaved] = useState(false)
  const tabButtons = useRef(new Map<SettingsTab, HTMLButtonElement>())

  const selectTab = (next: SettingsTab): void => {
    setTab(next)
    saveTab(next)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const moved = nextTab(tab, e.key)
    if (moved === tab) return
    e.preventDefault()
    selectTab(moved)
    tabButtons.current.get(moved)?.focus()
  }

  const flash = (): void => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <h2>
          {t('settings.title')} {saved && <span className="muted small">{t('settings.saved')}</span>}
        </h2>
      </header>
      <nav className="tabs" role="tablist" onKeyDown={onKeyDown}>
        {SETTINGS_TABS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              if (el) tabButtons.current.set(id, el)
              else tabButtons.current.delete(id)
            }}
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onClick={() => selectTab(id)}
          >
            {t(`settings.tabs.${id}`)}
          </button>
        ))}
      </nav>
      {/* All panels stay mounted so switching tabs never discards an unsaved extraction-form draft. */}
      <div className="tab-body">
        <div id="settings-panel-project" role="tabpanel" tabIndex={0} aria-labelledby="settings-tab-project" hidden={tab !== 'project'} className="narrow">
          <ProjectSection project={project} onSaved={flash} />
        </div>
        <div id="settings-panel-claude" role="tabpanel" tabIndex={0} aria-labelledby="settings-tab-claude" hidden={tab !== 'claude'} className="narrow">
          <ClaudeSection />
        </div>
        <div id="settings-panel-thesis" role="tabpanel" tabIndex={0} aria-labelledby="settings-tab-thesis" hidden={tab !== 'thesis'} className="narrow">
          <ThesisSection />
        </div>
        <div id="settings-panel-form" role="tabpanel" tabIndex={0} aria-labelledby="settings-tab-form" hidden={tab !== 'form'}>
          <ExtractionFormView />
        </div>
        <div id="settings-panel-app" role="tabpanel" tabIndex={0} aria-labelledby="settings-tab-app" hidden={tab !== 'app'} className="narrow">
          <AppSection onSaved={flash} />
        </div>
      </div>
    </div>
  )
}
