import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CANDIDATE_DIRECTIONS, type Candidate, type CandidateDirection, type CandidateList } from '../../../shared/relations'
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback'
import { useEvent } from '../../hooks/useEvent'
import { candidateLink, candidateTitle, defaultMinCount, MAX_ROWS } from '../../lib/candidates'
import { errorText } from '../../lib/errorText'

export function CandidatesTab({ paperId, onClearPaper }: { paperId: string | null; onClearPaper: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [direction, setDirection] = useState<CandidateDirection>('references')
  const [minCount, setMinCount] = useState(() => defaultMinCount(paperId))
  const [list, setList] = useState<CandidateList | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)

  useEffect(() => setMinCount(defaultMinCount(paperId)), [paperId])

  const refresh = useCallback(() => {
    setLoading(true)
    setNotice(null)
    let stale = false
    const cleanup = (): void => {
      stale = true
    }
    window.research.citations.candidates({ direction, minCount, ...(paperId ? { paperId } : {}) }).then(
      (next) => {
        if (stale) return
        setList(next)
        setLoading(false)
      },
      () => {
        if (stale) return
        setLoading(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
    return cleanup
  }, [direction, minCount, paperId, t])
  useEffect(refresh, [refresh])
  // A batch of jobs emits many library-changed events; refreshing once after them avoids repeated work.
  useEvent('library-changed', useDebouncedCallback(refresh, 800))

  const report = (result: { ok: true } | { ok: false; error: string }, success: string): void => {
    setNotice(result.ok ? { error: false, text: success } : { error: true, text: errorText(t, result.error) })
  }
  const add = (c: Candidate): void => {
    void window.research.citations.add(c.openalexId).then(
      (r) => report(r, t('map.candidates.added', { title: candidateTitle(c) })),
      () => report({ ok: false, error: 'unknown' }, '')
    )
  }
  const dismiss = (c: Candidate): void => {
    void window.research.citations.dismiss(c.openalexId).then(
      (r) => {
        if (r.ok) refresh()
        else report(r, '')
      },
      () => report({ ok: false, error: 'unknown' }, '')
    )
  }
  const fetchCitedBy = (): void => {
    void window.research.citations.fetchCitedBy().then(
      (r) => (r.ok ? report({ ok: true }, t('map.candidates.cited_by_queued', { count: r.count })) : report(r, '')),
      () => report({ ok: false, error: 'unknown' }, '')
    )
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
        <button onClick={fetchCitedBy}>{t('map.candidates.fetch_cited_by')}</button>
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
                    <button className="small primary" onClick={() => add(c)}>
                      {t('map.candidates.add')}
                    </button>
                    <button className="small" onClick={() => dismiss(c)}>
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
