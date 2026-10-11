import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConflictChoice, ConflictItem } from '../../../shared/sync'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { choiceButtons, keepChoices, missingChoices } from '../../lib/sync'
import { ConflictDiffView } from './ConflictDiffView'

/** «Conflictos por resolver»: a version per file (or per paper), then «Terminar sincronización»; «Cancelar» leaves everything as it was. */
export function ConflictsPanel({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<ConflictItem[] | null>(null)
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  // Bumped on every list, so an open «Ver diferencias» reads the versions again.
  const [revision, setRevision] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // «Terminar sincronización» found the conflicts changed since they were shown: review them again.
  const [changed, setChanged] = useState(false)
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    window.research.sync.conflicts().then(
      (next) => {
        if (token !== request.current) return
        setItems(next)
        setRevision((r) => r + 1)
        setChoices((prev) => keepChoices(prev, next))
      },
      () => {
        if (token === request.current) setError(errorText(t, 'unknown'))
      }
    )
  }, [t])
  useEffect(load, [load])
  useEvent('sync-changed', load)

  const finish = (): void => {
    if (busy || !items) return
    setBusy(true)
    setError(null)
    setChanged(false)
    window.research.sync.resolve(choices).then(
      (result) => {
        setBusy(false)
        if (result.ok && result.outcome === 'conflicts') {
          // A choice only applies to the versions that were shown: the app kept the ones still valid (those conflicts are
          // no longer listed), and every conflict listed now changed since (a newer save here, the remote moving) or is
          // new. Their old choices would be for versions the user never saw, so they are asked again.
          setChoices({})
          setChanged(true)
        }
        // A failure is kept in the status and shown by the Sync view's banner.
        load()
        onDone()
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
        load()
        onDone()
      }
    )
  }

  const cancel = (): void => {
    if (busy) return
    setBusy(true)
    window.research.sync.abort().then(
      () => {
        setBusy(false)
        onDone()
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
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
      <ul className="sync-conflict-list">
        {(items ?? []).map((item) => (
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
                  className={choices[item.id] === b.choice ? 'primary' : ''}
                  aria-pressed={choices[item.id] === b.choice}
                  disabled={busy}
                  onClick={() => setChoices((prev) => ({ ...prev, [item.id]: b.choice }))}
                >
                  {t(b.key)}
                </button>
              ))}
              <button className="link" onClick={() => setOpen((prev) => (prev === item.id ? null : item.id))}>
                {t(open === item.id ? 'sync.conflicts.hide_diff' : 'sync.conflicts.show_diff')}
              </button>
            </div>
            {open === item.id && <ConflictDiffView id={item.id} revision={revision} />}
          </li>
        ))}
      </ul>
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={busy || !items || missing > 0} onClick={finish}>
          {t('sync.conflicts.finish')}
        </button>
        <button disabled={busy} onClick={cancel}>
          {t('sync.conflicts.cancel')}
        </button>
        {missing > 0 && <span className="muted small">{t('sync.conflicts.pending', { count: missing })}</span>}
      </div>
      <p className="muted small">{t('sync.conflicts.cancel_help')}</p>
    </section>
  )
}
