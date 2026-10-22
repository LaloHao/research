import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WritingLibrary } from '../../../shared/writing/api'
import { useEvent } from '../../hooks/useEvent'
import { WRITING_TABS, type WritingTab } from '../../lib/navigation'
import { loadWritingPrefs, saveWritingPrefs, type WritingPrefs } from '../../lib/writing'
import { BibtexTab } from './BibtexTab'
import { CheckTab } from './CheckTab'
import { DraftTab } from './DraftTab'
import { OutlineTab } from './OutlineTab'
import { StyleTab } from './StyleTab'

/**
 * «Redacción»: tools for writing the thesis with what the library knows. Each tab reads only (drafts aside, kept in
 * drafts/); the output format
 * (Org, LaTeX or Markdown, and the LaTeX command) is shared by the tabs and remembered per project.
 */
export function WritingView({
  projectRoot,
  tab,
  onTabChange,
  visibleIds
}: {
  projectRoot: string
  tab: WritingTab
  onTabChange: (tab: WritingTab) => void
  /** The library's visible rows (its filters), for «Los filtrados en la biblioteca»; null until the library was shown. */
  visibleIds: string[] | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const [prefs, setPrefs] = useState<WritingPrefs>(() => loadWritingPrefs(projectRoot))
  const changePrefs = useCallback(
    (next: WritingPrefs) => {
      setPrefs(next)
      saveWritingPrefs(projectRoot, next)
    },
    [projectRoot]
  )
  // The keys a text may cite, refreshed when the library changes.
  const [library, setLibrary] = useState<WritingLibrary | null>(null)
  const loadLibrary = useCallback(() => {
    window.research.writing.library().then(setLibrary, () => setLibrary({ papers: [], trashed: [] }))
  }, [])
  useEffect(loadLibrary, [loadLibrary])
  useEvent('library-changed', loadLibrary)

  return (
    <div className="writing-view">
      <nav className="tabs" role="tablist">
        {WRITING_TABS.map((id) => (
          <button
            key={id}
            id={`writing-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`writing-panel-${id}`}
            className={tab === id ? 'active' : ''}
            onClick={() => onTabChange(id)}
          >
            {t(`writing.tabs.${id}`)}
          </button>
        ))}
      </nav>
      <div className="writing-body" id={`writing-panel-${tab}`} role="tabpanel" aria-labelledby={`writing-tab-${tab}`}>
        {tab === 'draft' && <DraftTab library={library} visibleIds={visibleIds} prefs={prefs} onPrefsChange={changePrefs} />}
        {tab === 'check' && <CheckTab library={library} />}
        {tab === 'outline' && <OutlineTab visibleIds={visibleIds} prefs={prefs} onPrefsChange={changePrefs} />}
        {tab === 'bibtex' && <BibtexTab />}
        {tab === 'style' && <StyleTab />}
      </div>
    </div>
  )
}
