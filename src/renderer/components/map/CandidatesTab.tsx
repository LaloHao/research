import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CANDIDATE_DIRECTIONS, type Candidate, type CandidateDirection, type CandidateList } from '../../../shared/relations'
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback'
import { useEvent } from '../../hooks/useEvent'
import { candidateAction, candidateLink, candidateTitle, defaultMinCount, MAX_ROWS } from '../../lib/candidates'
import { errorText } from '../../lib/errorText'
import { restoreDetails } from '../../lib/trash'

export function CandidatesTab({ paperId, onClearPaper }: { paperId: string | null; onClearPaper: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [direction, setDirection] = useState<CandidateDirection>('references')
  const [minCount, setMinCount] = useState(() => defaultMinCount(paperId))
  const [list, setList] = useState<CandidateList | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [fetchingCitedBy, setFetchingCitedBy] = useState(false)
  // Shared by the effect-driven refresh and the manual one after a dismiss: only the latest request may apply its result.
  const requestToken = useRef(0)

  useEffect(() => setMinCount(defaultMinCount(paperId)), [paperId])

  // `clearNotice` is false for the reload a library change triggers, so a notice about what just happened (a restore) stays.
  const load = useCallback(
    (clearNotice: boolean) => {
      const token = ++requestToken.current
      setLoading(true)
      if (clearNotice) setNotice(null)
      window.research.citations.candidates({ direction, minCount, ...(paperId ? { paperId } : {}) }).then(
        (next) => {
          if (requestToken.current !== token) return
          setList(next)
          setLoading(false)
        },
        () => {
          if (requestToken.current !== token) return
          setLoading(false)
          setNotice({ error: true, text: errorText(t, 'unknown') })
        }
      )
    },
    [direction, minCount, paperId, t]
  )
  const refresh = useCallback(() => load(true), [load])
  useEffect(refresh, [refresh])
  // A batch of jobs emits many library-changed events; refreshing once after them avoids repeated work.
  useEvent('library-changed', useDebouncedCallback(() => load(false), 800))

  const report = (result: { ok: true } | { ok: false; error: string }, success: string): void => {
    setNotice(result.ok ? { error: false, text: success } : { error: true, text: errorText(t, result.error) })
  }
  const withPending = (id: string, run: () => Promise<void>): void => {
    setPendingIds((prev) => new Set(prev).add(id))
    void run().finally(() => setPendingIds((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : prev)))
  }
  const add = (c: Candidate): void => {
    withPending(c.openalexId, () =>
      window.research.citations.add(c.openalexId).then(
        (r) => report(r, t('map.candidates.added', { title: candidateTitle(c) })),
        () => report({ ok: false, error: 'unknown' }, '')
      )
    )
  }
  /** A work that is a paper in the trash comes back from there, with everything it had. */
  const restore = (c: Candidate): void => {
    const paperId = c.trashedId
    if (!paperId) return
    withPending(c.openalexId, () =>
      window.research.trash.restore([paperId], false).then(
        (r) => {
          const details = restoreDetails(t, r)
          if (r.failed.length > 0) setNotice({ error: true, text: details.join(' ') })
          else if (r.conflicts.length > 0) setNotice({ error: true, text: t('map.candidates.restore_conflict') })
          else {
            // The reload goes first: it clears old notices, and this one must outlive it.
            load(false)
            setNotice({ error: false, text: [t('map.candidates.restored', { title: candidateTitle(c) }), ...details].join(' ') })
          }
        },
        () => report({ ok: false, error: 'unknown' }, '')
      )
    )
  }
  const dismiss = (c: Candidate): void => {
    withPending(c.openalexId, () =>
      window.research.citations.dismiss(c.openalexId).then(
        (r) => {
          if (r.ok) refresh()
          else report(r, '')
        },
        () => report({ ok: false, error: 'unknown' }, '')
      )
    )
  }
  const fetchCitedBy = (): void => {
    setFetchingCitedBy(true)
    void window.research.citations
      .fetchCitedBy()
      .then(
        (r) => (r.ok ? report({ ok: true }, t('map.candidates.cited_by_queued', { count: r.count })) : report(r, '')),
        () => report({ ok: false, error: 'unknown' }, '')
      )
      .finally(() => setFetchingCitedBy(false))
  }

  const rows = list?.candidates.slice(0, MAX_ROWS) ?? []
  const none = t('map.candidates.none_value')

  return (
    <div className="candidates">
      <div className="row small">
        <label>
          {t('map.candidates.direction')}{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as CandidateDirection)}>
            {CANDIDATE_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`map.candidates.directions.${d}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('map.candidates.min_count')}{' '}
          <input type="number" min={1} max={50} value={minCount} onChange={(e) => setMinCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
        </label>
        {paperId && (
          <span className="chip">
            {t('map.candidates.for_paper', { id: paperId })}
            <button className="chip-remove" onClick={onClearPaper} aria-label={t('map.candidates.clear_paper')}>
              ✕
            </button>
          </span>
        )}
        <button onClick={fetchCitedBy} disabled={fetchingCitedBy}>
          {t('map.candidates.fetch_cited_by')}
        </button>
      </div>
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {list?.metadataError && <div className="banner warning">{t('map.candidates.metadata_error', { error: errorText(t, list.metadataError) })}</div>}
      {loading && !list && <p className="muted">{t('map.candidates.loading')}</p>}
      {list && list.candidates.length === 0 && <p className="muted">{t('map.candidates.empty')}</p>}
      {list && list.candidates.length > MAX_ROWS && <p className="muted small">{t('map.candidates.showing', { shown: MAX_ROWS, total: list.candidates.length })}</p>}
      {rows.length > 0 && (
        <table className="candidates-table">
          <thead>
            <tr>
              <th>{t('map.candidates.columns.title')}</th>
              <th>{t('map.candidates.columns.year')}</th>
              <th>{t('map.candidates.columns.authors')}</th>
              <th>{t('map.candidates.columns.cited_by_library')}</th>
              <th>{t('map.candidates.columns.cites_library')}</th>
              <th>{t('map.candidates.columns.total')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.openalexId}>
                <td>
                  <a href={candidateLink(c)} target="_blank" rel="noreferrer">
                    {candidateTitle(c)}
                  </a>
                </td>
                <td>{c.work?.year ?? none}</td>
                <td>{c.work?.authors || none}</td>
                <td>{c.citedByLibrary}</td>
                <td>{c.citesLibrary}</td>
                <td>{c.work?.citedByCount ?? none}</td>
                <td>
                  <div className="row">
                    {candidateAction(c) === 'restore' ? (
                      <>
                        <span className="chip">{t('map.candidates.in_trash')}</span>
                        <button className="small primary" onClick={() => restore(c)} disabled={pendingIds.has(c.openalexId)}>
                          {t('map.candidates.restore')}
                        </button>
                      </>
                    ) : (
                      <button className="small primary" onClick={() => add(c)} disabled={pendingIds.has(c.openalexId)}>
                        {t('map.candidates.add')}
                      </button>
                    )}
                    <button className="small" onClick={() => dismiss(c)} disabled={pendingIds.has(c.openalexId)}>
                      {t('map.candidates.dismiss')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
