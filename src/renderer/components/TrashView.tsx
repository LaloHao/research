import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeletePlan, RestoreConflict, TrashEntry, TrashTarget } from '../../shared/trash'
import { useEvent } from '../hooks/useEvent'
import { errorText } from '../lib/errorText'
import { deviceKind, filterTrash, prune, restorable, restoreDetails, shortDevice, toggle, toggleAll, trashedDay } from '../lib/trash'

type Notice = { error: boolean; text: string }

/** The Papelera: restore (or merge) papers, or delete them for good after a confirmation that counts their relations. */
export function TrashView(): React.JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // The confirmation keeps the exact keys deletePlan counted: those, and only those, are deleted.
  const [confirm, setConfirm] = useState<{ all: boolean; plan: DeletePlan } | null>(null)
  const [conflicts, setConflicts] = useState<RestoreConflict[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const request = useRef(0)

  const refresh = useCallback(() => {
    const token = ++request.current
    window.research.trash.list().then(
      (next) => {
        if (token !== request.current) return
        setEntries(next)
        setSelected((prev) => prune(prev, next))
        setConflicts((prev) => prev.filter((c) => next.some((e) => e.id === c.id)))
      },
      () => {
        if (token === request.current) setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }, [t])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)

  const visible = useMemo(() => filterTrash(entries ?? [], query), [entries, query])
  const chosen = useMemo(() => [...selected], [selected])
  // An entry with a problem cannot be restored (its own button is disabled): the batch leaves it out too.
  const restorableChosen = useMemo(() => restorable(entries ?? [], selected), [entries, selected])
  const failed = (): void => {
    setBusy(false)
    setNotice({ error: true, text: errorText(t, 'unknown') })
  }

  const restore = (ids: string[], merge: boolean): void => {
    if (busy || ids.length === 0) return
    setBusy(true)
    setNotice(null)
    setConfirm(null)
    window.research.trash.restore(ids, merge).then((r) => {
      setBusy(false)
      setConflicts((prev) => [...prev.filter((c) => !ids.includes(c.id)), ...r.conflicts])
      const parts = [...(r.restored.length > 0 ? [t('trash.restored', { count: r.restored.length })] : []), ...restoreDetails(t, r)]
      setNotice(parts.length > 0 ? { error: r.failed.length > 0, text: parts.join(' ') } : null)
      refresh()
    }, failed)
  }

  const planDelete = (target: TrashTarget): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    setConfirm(null)
    window.research.trash.deletePlan(target).then((r) => {
      setBusy(false)
      if (!r.ok) setNotice({ error: true, text: errorText(t, r.error) })
      else if (r.plan.papers > 0) setConfirm({ all: target === 'all', plan: r.plan })
      // Nothing left to delete (another machine already did): the list catches up.
      else refresh()
    }, failed)
  }

  const runDelete = (): void => {
    if (!confirm || busy) return
    setBusy(true)
    window.research.trash.deleteForever(confirm.plan.ids).then((r) => {
      setBusy(false)
      setConfirm(null)
      setNotice(r.ok ? { error: false, text: t('trash.deleted', { count: r.count }) } : { error: true, text: errorText(t, r.error) })
      refresh()
    }, failed)
  }

  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.id))

  return (
    <div className="trash">
      <header className="trash-header">
        <h2>{t('trash.title')}</h2>
        <input className="search" type="search" value={query} placeholder={t('trash.search_placeholder')} onChange={(e) => setQuery(e.target.value)} />
        <div className="row small">
          <label>
            <input type="checkbox" checked={allVisibleSelected} disabled={visible.length === 0} onChange={() => setSelected((prev) => toggleAll(prev, visible))} />{' '}
            {t('trash.select_visible')}
          </label>
          <button disabled={busy || restorableChosen.length === 0} onClick={() => restore(restorableChosen, false)}>
            {t('trash.restore_selected', { count: restorableChosen.length })}
          </button>
          <button disabled={busy || chosen.length === 0} onClick={() => planDelete(chosen)}>
            {t('trash.delete_selected', { count: chosen.length })}
          </button>
          <button className="danger" disabled={busy || !entries || entries.length === 0} onClick={() => planDelete('all')}>
            {t('trash.empty_trash')}
          </button>
        </div>
      </header>
      {confirm && (
        <div className="banner warning">
          <span>{t(confirm.all ? 'trash.empty_confirm' : 'trash.delete_confirm', { count: confirm.plan.papers, relations: confirm.plan.relations })}</span>
          <button className="danger" disabled={busy} onClick={runDelete}>
            {t('trash.delete_forever')}
          </button>
          <button disabled={busy} onClick={() => setConfirm(null)}>
            {t('jobs.cancel')}
          </button>
        </div>
      )}
      {conflicts.map((c) => (
        <div key={c.id} className="banner warning">
          <span>{t('trash.conflict', { title: c.title, target: c.target })}</span>
          <button className="primary" disabled={busy} onClick={() => restore([c.id], true)}>
            {t('trash.merge')}
          </button>
          <button disabled={busy} onClick={() => setConflicts((prev) => prev.filter((x) => x.id !== c.id))}>
            {t('jobs.cancel')}
          </button>
        </div>
      ))}
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {entries?.length === 0 && <p className="muted pad">{t('trash.empty')}</p>}
      {entries && entries.length > 0 && visible.length === 0 && <p className="muted pad">{t('trash.no_results', { query })}</p>}
      <ul className="trash-list">
        {visible.map((e) => (
          <li key={e.id} className="trash-row">
            <label className="trash-row-title">
              <input type="checkbox" checked={selected.has(e.id)} onChange={() => setSelected((prev) => toggle(prev, e.id))} />
              <span className="paper-title">{e.title}</span>
            </label>
            <span className="muted small">{[e.authors_label, e.year].filter(Boolean).join(' · ')}</span>
            <span className="muted small">
              {t('trash.removed_on', {
                date: trashedDay(e.trashed_at) ?? t('trash.unknown_date'),
                device: t(`trash.device.${deviceKind(e)}`, { id: shortDevice(e.device) })
              })}
            </span>
            {e.problem && <span className="error small">{t('trash.problem', { problem: t(`trash.problems.${e.problem}`) })}</span>}
            <div className="row small">
              <button className="small" disabled={busy || e.problem !== null} onClick={() => restore([e.id], false)}>
                {t('trash.restore')}
              </button>
              <button className="small" disabled={busy} onClick={() => planDelete([e.id])}>
                {t('trash.delete_forever')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
