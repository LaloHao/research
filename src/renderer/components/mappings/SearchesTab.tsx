import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportChoice } from '../../../shared/ipc'
import type { PaperRow } from '../../../shared/library'
import type { PaperKind } from '../../../shared/schemas'
import {
  DATABASE_NAMES,
  MAX_QUERY,
  OPENALEX_TYPES,
  SEARCH_CAP,
  SNOWBALL_DIRECTIONS,
  type MappingView,
  type OpenAlexSearchRequest,
  type OpenAlexType,
  type SnowballDirection,
  YEAR_MAX,
  YEAR_MIN
} from '../../../shared/mapping'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { nextSnowballIteration, openAlexPlanLines, openAlexRequest, openAlexTypesFor, searchField, searchFilters, searchSource, snowballPlanLines } from '../../lib/mappings'

type Notice = { error: boolean; text: string } | null

const OTHER = '__other__'

function NoticeBanner({ notice }: { notice: Notice }): React.JSX.Element | null {
  return notice ? <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div> : null
}

/** What a search will do before it runs: «Cancelar» has the focus, and Esc cancels too. */
function ConfirmBanner({ lines, busy, onConfirm, onCancel }: { lines: string[]; busy: boolean; onConfirm: () => void; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="banner search-confirm"
      role="group"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {t('mappings.searches.confirm_run')}
        </button>
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>
          {t('mappings.searches.cancel')}
        </button>
      </div>
    </div>
  )
}

function OpenAlexForm({ view }: { view: MappingView }): React.JSX.Element {
  const { t } = useTranslation()
  const p = view.protocol.protocol
  const [query, setQuery] = useState('')
  const [fromYear, setFromYear] = useState(p.years.from?.toString() ?? '')
  const [toYear, setToYear] = useState(p.years.to?.toString() ?? '')
  const [types, setTypes] = useState<OpenAlexType[]>(() => openAlexTypesFor(p.publication_types))
  const [cap, setCap] = useState(String(SEARCH_CAP.default))
  /** The years and types were changed here: a later protocol edit no longer refills them. */
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState<OpenAlexSearchRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  // The panel stays mounted while «Protocolo» is edited: follow the protocol's years and types until the user changes them here.
  const kinds = p.publication_types.join(',')
  useEffect(() => {
    if (touched) return
    setFromYear(p.years.from?.toString() ?? '')
    setToYear(p.years.to?.toString() ?? '')
    setTypes(openAlexTypesFor(kinds ? (kinds.split(',') as PaperKind[]) : []))
    setPending(null)
  }, [p.years.from, p.years.to, kinds, touched])

  const form = { query, fromYear, toYear, types, cap }
  const checked = openAlexRequest(form)
  const yearsInvalid = !openAlexRequest({ ...form, query: 'x' }).ok

  /** Any edit drops a confirmation shown for the previous values. */
  const edit =
    <T,>(set: (value: T) => void, filter = false) =>
    (value: T): void => {
      set(value)
      if (filter) setTouched(true)
      setPending(null)
    }

  const ask = (): void => {
    if (busy || !checked.ok) return
    setNotice(null)
    setPending(checked.req)
  }

  const run = (): void => {
    if (busy || !pending) return
    setBusy(true)
    window.research.mappings.searchOpenAlex(view.id, pending, true).then(
      (r) => {
        setBusy(false)
        setPending(null)
        setNotice(r.ok ? { error: false, text: t('mappings.searches.queued') } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setPending(null)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  return (
    <details className="search-form" open>
      <summary>{t('mappings.searches.openalex')}</summary>
      <label>
        {t('mappings.searches.query')}
        <textarea value={query} maxLength={MAX_QUERY} onChange={(e) => edit(setQuery)(e.target.value)} />
      </label>
      <p className="muted small">{t('mappings.searches.query_help')}</p>
      <div className="row small">
        <label>
          {t('mappings.searches.year_from')} <input type="number" min={YEAR_MIN} max={YEAR_MAX} value={fromYear} onChange={(e) => edit(setFromYear, true)(e.target.value)} />
        </label>
        <label>
          {t('mappings.searches.year_to')} <input type="number" min={YEAR_MIN} max={YEAR_MAX} value={toYear} onChange={(e) => edit(setToYear, true)(e.target.value)} />
        </label>
        <label>
          {t('mappings.searches.cap')} <input type="number" min={1} max={SEARCH_CAP.max} value={cap} onChange={(e) => edit(setCap)(e.target.value)} />
        </label>
      </div>
      {!checked.ok && checked.problem === 'separator' && <p className="warning-text small">{t('mappings.searches.query_separator')}</p>}
      {yearsInvalid && <p className="warning-text small">{t('mappings.searches.years_invalid')}</p>}
      <fieldset className="checks small">
        <legend>{t('mappings.searches.types')}</legend>
        {OPENALEX_TYPES.map((type) => (
          <label key={type}>
            <input
              type="checkbox"
              checked={types.includes(type)}
              onChange={(e) => {
                const on = e.target.checked
                edit(setTypes, true)(on ? [...types.filter((x) => x !== type), type] : types.filter((x) => x !== type))
              }}
            />{' '}
            {t(`mappings.openalex_types.${type}`)}
          </label>
        ))}
      </fieldset>
      {pending ? (
        <ConfirmBanner lines={openAlexPlanLines(t, pending)} busy={busy} onConfirm={run} onCancel={() => setPending(null)} />
      ) : (
        <button type="button" disabled={busy || !checked.ok} onClick={ask}>
          {t('mappings.searches.run')}
        </button>
      )}
      <NoticeBanner notice={notice} />
    </details>
  )
}

function ImportForm({ mappingId }: { mappingId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [file, setFile] = useState<ImportChoice | null>(null)
  const [database, setDatabase] = useState<string>(DATABASE_NAMES[0])
  const [other, setOther] = useState('')
  const [query, setQuery] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const name = database === OTHER ? other.trim() : database

  const choose = (): void => {
    if (choosing || busy) return
    setChoosing(true)
    window.research.mappings.chooseImportFile().then(
      (picked) => {
        setChoosing(false)
        if (picked) {
          setFile(picked)
          setNotice(null)
        }
      },
      () => {
        setChoosing(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const run = (): void => {
    if (busy || !file || !name) return
    setBusy(true)
    setNotice(null)
    // The token names the file once: whatever the answer, a new attempt needs the file picked again.
    const token = file.token
    setFile(null)
    window.research.mappings.importFile(mappingId, token, { database: name, query }).then(
      (r) => {
        setBusy(false)
        if (!r.ok) {
          setNotice({ error: true, text: `${errorText(t, r.error)} ${t('mappings.searches.pick_again')}` })
          return
        }
        const { truncated, ...counts } = r.outcome
        const text = t('mappings.searches.imported', counts)
        setNotice({ error: false, text: truncated ? `${text} ${t('mappings.searches.truncated')}` : text })
        setQuery('')
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: `${errorText(t, 'unknown')} ${t('mappings.searches.pick_again')}` })
      }
    )
  }

  return (
    <details className="search-form">
      <summary>{t('mappings.searches.import')}</summary>
      <p className="muted small">{t('mappings.searches.import_help')}</p>
      <div className="row small">
        <button type="button" disabled={choosing || busy} onClick={choose}>
          {t('mappings.searches.choose_file')}
        </button>
        <span className="muted">{file ? file.name : t('mappings.searches.no_file')}</span>
      </div>
      <label>
        {t('mappings.searches.database')}{' '}
        <select value={database} onChange={(e) => setDatabase(e.target.value)}>
          {DATABASE_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value={OTHER}>{t('mappings.searches.database_other')}</option>
        </select>
      </label>
      {database === OTHER && (
        <input
          value={other}
          maxLength={200}
          placeholder={t('mappings.searches.database_other_placeholder')}
          aria-label={t('mappings.searches.database_other_placeholder')}
          onChange={(e) => setOther(e.target.value)}
        />
      )}
      <label>
        {t('mappings.searches.import_query')}
        <textarea value={query} maxLength={MAX_QUERY} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button type="button" disabled={busy || !file || !name} onClick={run}>
        {t('mappings.searches.import_run')}
      </button>
      <NoticeBanner notice={notice} />
    </details>
  )
}

function LibraryPicker({ mappingId }: { mappingId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [papers, setPapers] = useState<PaperRow[]>([])
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    window.research.library.list('').then(
      (rows) => {
        if (token === request.current) setPapers(rows)
      },
      () => {
        if (token === request.current) setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }, [t])
  useEffect(() => {
    if (open) load()
  }, [open, load])
  useEvent('library-changed', () => {
    if (open) load()
  })

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? papers.filter((p) => `${p.title} ${p.authors_label} ${p.year ?? ''}`.toLowerCase().includes(q)) : papers
  }, [papers, filter])

  const toggle = (id: string): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = (): void => {
    if (busy || picked.size === 0) return
    setBusy(true)
    setNotice(null)
    window.research.mappings.addFromLibrary(mappingId, [...picked]).then(
      (r) => {
        setBusy(false)
        if (!r.ok) {
          setNotice({ error: true, text: errorText(t, r.error) })
          return
        }
        const { truncated, ...counts } = r.outcome
        const text = t('mappings.searches.imported', counts)
        setNotice({ error: false, text: truncated ? `${text} ${t('mappings.searches.truncated')}` : text })
        setPicked(new Set())
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  return (
    <details className="search-form" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('mappings.searches.library')}</summary>
      <p className="muted small">{t('mappings.searches.library_help')}</p>
      <input value={filter} placeholder={t('mappings.searches.library_search')} aria-label={t('mappings.searches.library_search')} onChange={(e) => setFilter(e.target.value)} />
      {shown.length === 0 ? (
        <p className="muted small">{t('mappings.searches.library_empty')}</p>
      ) : (
        <ul className="plain-list library-picker">
          {shown.map((p) => (
            <li key={p.id}>
              <label>
                <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} /> {p.title}{' '}
                <span className="muted small">{[p.authors_label, p.year].filter(Boolean).join(' · ')}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy || picked.size === 0} onClick={run}>
        {t('mappings.searches.library_add', { count: picked.size })}
      </button>
      <NoticeBanner notice={notice} />
    </details>
  )
}

function SnowballForm({ view }: { view: MappingView }): React.JSX.Element {
  const { t } = useTranslation()
  const [direction, setDirection] = useState<SnowballDirection>('both')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const included = view.counts.full_text.include
  const canRun = included > 0

  const run = (): void => {
    if (busy || !canRun) return
    setBusy(true)
    window.research.mappings.snowball(view.id, direction, true).then(
      (r) => {
        setBusy(false)
        setConfirming(false)
        setNotice(r.ok ? { error: false, text: t('mappings.searches.snowball_queued') } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setConfirming(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  return (
    <details className="search-form">
      <summary>{t('mappings.searches.snowball')}</summary>
      <p className="muted small">{t('mappings.searches.snowball_help')}</p>
      {!canRun && <p className="muted small">{t('mappings.searches.snowball_none')}</p>}
      <label>
        {t('mappings.searches.direction')}{' '}
        <select
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value as SnowballDirection)
            setConfirming(false)
          }}
        >
          {SNOWBALL_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {t(`mappings.searches.directions.${d}`)}
            </option>
          ))}
        </select>
      </label>
      {confirming && canRun ? (
        <ConfirmBanner
          lines={snowballPlanLines(t, { direction, included, iteration: nextSnowballIteration(view.searches) })}
          busy={busy}
          onConfirm={run}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button
          type="button"
          disabled={busy || !canRun}
          onClick={() => {
            setNotice(null)
            setConfirming(true)
          }}
        >
          {t('mappings.searches.snowball_run')}
        </button>
      )}
      <NoticeBanner notice={notice} />
    </details>
  )
}

function SearchLog({ view }: { view: MappingView }): React.JSX.Element {
  const { t } = useTranslation()
  const [discarding, setDiscarding] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const inconsistent = useMemo(() => new Set(view.inconsistentSearches), [view.inconsistentSearches])
  useEffect(() => {
    if (discarding) reasonRef.current?.focus()
  }, [discarding])

  const discard = (searchId: string): void => {
    if (busy || !reason.trim()) return
    setBusy(true)
    setNotice(null)
    window.research.mappings.discardSearch(view.id, searchId, reason.trim()).then(
      (r) => {
        setBusy(false)
        if (r.ok) setDiscarding(null)
        else setNotice({ error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  return (
    <section className="search-log">
      <h3>{t('mappings.searches.log')}</h3>
      <p className="muted small">{t('mappings.searches.log_help')}</p>
      <NoticeBanner notice={notice} />
      {view.searches.length === 0 ? (
        <p className="muted">{t('mappings.searches.empty')}</p>
      ) : (
        <table className="search-log-table small">
          <thead>
            <tr>
              <th>{t('mappings.searches.columns.date')}</th>
              <th>{t('mappings.searches.columns.source')}</th>
              <th>{t('mappings.searches.columns.query')}</th>
              <th>{t('mappings.searches.columns.filters')}</th>
              <th>{t('mappings.searches.columns.count')}</th>
              <th>{t('mappings.searches.columns.machine')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.searches.map((s) => (
              <tr key={s.id} className={s.discarded ? 'discarded' : undefined}>
                <td>{new Date(s.at).toLocaleString()}</td>
                <td>
                  {searchSource(t, s)}
                  {s.file && <div className="muted">{t('mappings.searches.file', { file: s.file })}</div>}
                </td>
                <td className="search-query">
                  {s.query ?? '—'}
                  {s.field && <div className="muted">{searchField(t, s)}</div>}
                </td>
                <td>{searchFilters(s)}</td>
                <td>
                  {s.total !== null && s.total !== s.count ? t('mappings.searches.count_of_total', { count: s.count, total: s.total }) : s.count}
                  {s.capped && <div className="warning-text">{t('mappings.searches.capped')}</div>}
                  {s.skipped > 0 && <div className="muted">{t('mappings.searches.skipped', { count: s.skipped })}</div>}
                  {inconsistent.has(s.id) && <div className="warning-text">{t('mappings.searches.inconsistent')}</div>}
                </td>
                <td>{s.machine}</td>
                <td>
                  {s.discarded ? (
                    <span className="muted">{t('mappings.searches.discarded', { date: new Date(s.discarded.at).toLocaleDateString(), reason: s.discarded.reason })}</span>
                  ) : discarding === s.id ? (
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault()
                        discard(s.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && !busy) setDiscarding(null)
                      }}
                    >
                      <input
                        ref={reasonRef}
                        value={reason}
                        maxLength={500}
                        placeholder={t('mappings.searches.discard_reason')}
                        aria-label={t('mappings.searches.discard_reason')}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <button type="submit" disabled={busy || !reason.trim()}>
                        {t('mappings.searches.discard_confirm')}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setDiscarding(null)}>
                        {t('mappings.searches.cancel')}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      disabled={busy}
                      onClick={() => {
                        setDiscarding(s.id)
                        setReason('')
                        setNotice(null)
                      }}
                    >
                      {t('mappings.searches.discard')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** «Búsquedas»: every way records come in, and the log that keeps each search for the report. */
export function SearchesTab({ view }: { view: MappingView }): React.JSX.Element {
  return (
    <div className="searches">
      <div className="search-forms">
        <OpenAlexForm view={view} />
        <ImportForm mappingId={view.id} />
        <LibraryPicker mappingId={view.id} />
        <SnowballForm view={view} />
      </div>
      <SearchLog view={view} />
    </div>
  )
}
