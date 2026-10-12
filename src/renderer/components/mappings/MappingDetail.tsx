import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MappingView } from '../../../shared/mapping'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { MAPPING_TABS, type MappingTab } from '../../lib/navigation'
import { ProtocolTab } from './ProtocolTab'

/** Where the arrow keys, Home and End move the active tab to (wrapping around the ends). */
function movedTab(current: MappingTab, key: string): MappingTab {
  const index = MAPPING_TABS.indexOf(current)
  const last = MAPPING_TABS.length - 1
  switch (key) {
    case 'ArrowLeft':
      return MAPPING_TABS[index === 0 ? last : index - 1]
    case 'ArrowRight':
      return MAPPING_TABS[index === last ? 0 : index + 1]
    case 'Home':
      return MAPPING_TABS[0]
    case 'End':
      return MAPPING_TABS[last]
    default:
      return current
  }
}

/** One mapping: its title, version and tabs. Reloaded whenever a mapping changes (a job, a sync, another tab's write). */
export function MappingDetail({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<MappingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<MappingTab>('protocol')
  const tabButtons = useRef(new Map<MappingTab, HTMLButtonElement>())
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    window.research.mappings.open(id).then(
      (r) => {
        if (token !== request.current) return
        if (r.ok) {
          setView(r.mapping)
          setError(null)
        } else setError(errorText(t, r.error))
      },
      () => {
        if (token === request.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [id, t])
  useEffect(load, [load])
  useEvent('mappings-changed', load)

  const onTabKey = (e: React.KeyboardEvent): void => {
    const next = movedTab(tab, e.key)
    if (next === tab) return
    e.preventDefault()
    setTab(next)
    tabButtons.current.get(next)?.focus()
  }

  if (!view)
    return error ? (
      <div className="pad">
        <div className="banner error">{error}</div>
      </div>
    ) : (
      <div className="center muted">{t('app.loading')}</div>
    )

  return (
    <div className="mapping-detail">
      <header className="mapping-header">
        <h2>{view.protocol.protocol.title}</h2>
        <span className="muted small">{t('mappings.protocol.version', { version: view.protocol.version })}</span>
      </header>
      {/* A reload that failed keeps the last view; the error says why it may be out of date. */}
      {error && <div className="banner error">{error}</div>}
      <nav className="tabs" role="tablist" onKeyDown={onTabKey}>
        {MAPPING_TABS.map((key) => (
          <button
            key={key}
            ref={(el) => {
              if (el) tabButtons.current.set(key, el)
              else tabButtons.current.delete(key)
            }}
            role="tab"
            id={`mapping-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`mapping-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {t(`mappings.tabs.${key}`)}
          </button>
        ))}
      </nav>
      {/* Panels stay mounted, so switching tabs never discards an unsaved protocol draft. */}
      <div className="mapping-body">
        <div id="mapping-panel-protocol" role="tabpanel" aria-labelledby="mapping-tab-protocol" hidden={tab !== 'protocol'}>
          <ProtocolTab view={view} onSaved={load} />
        </div>
      </div>
    </div>
  )
}
