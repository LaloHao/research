import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConflictDecision, ConflictItem } from '../../../shared/sync'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { choiceButtons, choiceOf, keepChoices, missingChoices, pathList, staleChoices } from '../../lib/sync'
import { ConflictDiffView } from './ConflictDiffView'

interface ConflictsPanelProps {
  onDone: () => void
  /** A sync is running (from the rail, before closing…): nothing can be decided or cancelled until it ends. */
  syncing: boolean
}

/** «Conflictos por resolver»: a version per file (or per paper), then «Terminar sincronización»; «Cancelar» leaves everything as it was. */
export function ConflictsPanel({ onDone, syncing }: ConflictsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<ConflictItem[] | null>(null)
  // Each choice is bound to the version of the conflict it was made for.
  const [choices, setChoices] = useState<Record<string, ConflictDecision>>({})
  const choicesRef = useRef(choices)
  choicesRef.current = choices
  // Bumped on every list, so an open «Ver diferencias» reads the versions again.
  const [revision, setRevision] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // What went wrong with «Terminar sincronización» or «Cancelar», next to those buttons.
  const [actionError, setActionError] = useState<string | null>(null)
  // A conflict changed since the user chose for it (a newer save here, the remote moving): review it again.
  const [changed, setChanged] = useState(false)
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    window.research.sync.conflicts().then(
      (next) => {
        if (token !== request.current) return
        setLoadError(null)
        setItems(next)
        setRevision((r) => r + 1)
        if (staleChoices(choicesRef.current, next).length > 0) setChanged(true)
        setChoices((prev) => keepChoices(prev, next))
      },
      () => {
        if (token === request.current) setLoadError(errorText(t, 'unknown'))
      }
    )
  }, [t])
  useEffect(load, [load])
  useEvent('sync-changed', load)

  const locked = busy || syncing
  const finish = (): void => {
    if (locked || !items) return
    setBusy(true)
    setActionError(null)
    setChanged(false)
    window.research.sync.resolve(choices).then(
      (result) => {
        setBusy(false)
        // Every conflict still listed is new or changed since it was shown (the app keeps the choices that still apply,
        // and their conflicts are no longer listed); `load` drops the choices made for older versions.
        if (result.ok && result.outcome === 'conflicts') setChanged(true)
        // Also in the Sync view's banner, which may be scrolled out of sight above a long list.
        if (!result.ok) setActionError(t(`sync.errors.${result.error.code}`, { paths: pathList(result.error.paths) }))
        load()
        onDone()
      },
      () => {
        setBusy(false)
        setActionError(errorText(t, 'unknown'))
        load()
        onDone()
      }
    )
  }

  const cancel = (): void => {
    if (locked) return
    setBusy(true)
    setActionError(null)
    window.research.sync.abort().then(
      () => {
        setBusy(false)
        onDone()
      },
      () => {
        setBusy(false)
        setActionError(errorText(t, 'unknown'))
      }
    )
  }

  const missing = items ? missingChoices(items, choices) : 0
  return (
    <section className="sync-conflicts">
      <h3>{t('sync.conflicts.title')}</h3>
      <p>{t('sync.conflicts.intro')}</p>
      <p className="muted small">{t('sync.conflicts.history_note')}</p>
      {changed && (
        <div className="banner warning" role="alert">
          {t('sync.conflicts.changed')}
        </div>
      )}
      {loadError && <div className="banner error">{loadError}</div>}
      <ul className="sync-conflict-list">
        {(items ?? []).map((item) => {
          const picked = choiceOf(item, choices)
          return (
            <li key={item.id} className="sync-conflict">
              <div className="sync-conflict-title">
                <strong>
                  {item.kind === 'paper'
                    ? item.paperTitle
                      ? t('sync.conflicts.paper', { title: item.paperTitle })
                      : t('sync.conflicts.paper_key', { key: item.paperId })
                    : item.path}
                </strong>
                {item.kind === 'file' && item.paperId && <span className="muted small">{item.paperTitle ?? item.paperId}</span>}
              </div>
              <span className="muted small">
                {t('sync.conflicts.mine', { side: t(`sync.sides.${item.ours}`) })} · {t('sync.conflicts.theirs', { side: t(`sync.sides.${item.theirs}`) })}
              </span>
              <div className="row small">
                {choiceButtons(item).map((b) => (
                  <button
                    key={b.choice}
                    className={picked === b.choice ? 'primary' : ''}
                    aria-pressed={picked === b.choice}
                    disabled={locked}
                    onClick={() => setChoices((prev) => ({ ...prev, [item.id]: { choice: b.choice, version: item.version } }))}
                  >
                    {t(b.key)}
                  </button>
                ))}
                <button className="link" aria-expanded={open === item.id} onClick={() => setOpen((prev) => (prev === item.id ? null : item.id))}>
                  {t(open === item.id ? 'sync.conflicts.hide_diff' : 'sync.conflicts.show_diff')}
                </button>
              </div>
              {open === item.id && <ConflictDiffView id={item.id} revision={revision} />}
            </li>
          )
        })}
      </ul>
      <div className="row">
        <button className="primary" disabled={locked || !items || items.length === 0 || missing > 0} onClick={finish}>
          {t('sync.conflicts.finish')}
        </button>
        <button disabled={locked} onClick={cancel}>
          {t('sync.conflicts.cancel')}
        </button>
        {syncing ? (
          <span className="muted small">{t('sync.conflicts.wait_sync')}</span>
        ) : (
          missing > 0 && <span className="muted small">{t('sync.conflicts.pending', { count: missing })}</span>
        )}
      </div>
      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}
      <p className="muted small">{t('sync.conflicts.cancel_help')}</p>
    </section>
  )
}
