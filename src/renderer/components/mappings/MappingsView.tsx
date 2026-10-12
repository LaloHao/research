import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MappingSummary } from '../../../shared/mapping'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { MappingDetail } from './MappingDetail'

/** «Mapeos»: the project's systematic mappings, and the one picked. */
export function MappingsView(): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<MappingSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    window.research.mappings.list().then(
      (items) => {
        if (token !== request.current) return
        setList(items)
        setListError(null)
        // A mapping that went away (a sync) is no longer selected.
        setSelected((current) => (current && items.some((m) => m.id === current) ? current : (items[0]?.id ?? null)))
      },
      () => {
        if (token === request.current) setListError(errorText(t, 'unknown'))
      }
    )
  }, [t])
  useEffect(load, [load])
  useEvent('mappings-changed', load)

  const create = (): void => {
    const name = title.trim()
    if (busy || !name) return
    setBusy(true)
    setCreateError(null)
    window.research.mappings.create(name).then(
      (r) => {
        setBusy(false)
        if (!r.ok) {
          setCreateError(errorText(t, r.error))
          return
        }
        setCreating(false)
        setTitle('')
        setSelected(r.id)
        load()
      },
      () => {
        setBusy(false)
        setCreateError(errorText(t, 'unknown'))
      }
    )
  }

  const cancel = (): void => {
    setCreating(false)
    setTitle('')
    setCreateError(null)
  }

  return (
    <div className="mappings">
      <aside className="mappings-side">
        <div className="row">
          <strong>{t('mappings.title')}</strong>
          <button className="small" disabled={creating} onClick={() => setCreating(true)}>
            {t('mappings.new')}
          </button>
        </div>
        {creating && (
          <form
            className="mappings-new"
            onSubmit={(e) => {
              e.preventDefault()
              create()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) cancel()
            }}
          >
            <input
              autoFocus
              value={title}
              maxLength={300}
              placeholder={t('mappings.new_title_placeholder')}
              aria-label={t('mappings.new_title_placeholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="row small">
              <button type="submit" className="primary" disabled={busy || !title.trim()}>
                {t('mappings.create')}
              </button>
              <button type="button" disabled={busy} onClick={cancel}>
                {t('mappings.cancel')}
              </button>
            </div>
          </form>
        )}
        {createError && <div className="banner error">{createError}</div>}
        {listError && <div className="banner error">{listError}</div>}
        {list?.length === 0 && !creating && <p className="muted small">{t('mappings.empty')}</p>}
        <ul className="plain-list mappings-list">
          {list?.map((m) => (
            <li key={m.id}>
              <button
                className={`mappings-item${m.id === selected ? ' active' : ''}`}
                aria-current={m.id === selected ? 'true' : undefined}
                onClick={() => setSelected(m.id)}
              >
                <span>{m.title || m.id}</span>
                <span className={`small ${m.problem ? 'warning-text' : 'muted'}`}>
                  {m.problem ? t('mappings.problem_short') : t('mappings.summary', { records: m.records, pending: m.pending, included: m.included })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="mappings-main">
        {selected ? (
          // Keyed by the mapping: tabs and loaded data never leak from one mapping to the next (a protocol draft is kept apart).
          <MappingDetail key={selected} id={selected} />
        ) : (
          <div className="center muted">{list && list.length > 0 ? t('mappings.select') : list ? t('mappings.empty') : t('app.loading')}</div>
        )}
      </section>
    </div>
  )
}
