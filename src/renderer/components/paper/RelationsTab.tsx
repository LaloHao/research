import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LinkedPaper, RelationsDetail } from '../../../shared/relations'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { reasonsText } from '../../lib/reasons'
import { citationsState, scorePercent } from '../../lib/relationsView'

function PaperLinks({ title, papers, onSelect }: { title: string; papers: LinkedPaper[]; onSelect?: (id: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section>
      <h3>{title}</h3>
      {papers.length === 0 ? (
        <p className="muted small">{t('relations.none_in_library')}</p>
      ) : (
        <ul className="relations-list">
          {papers.map((p) => (
            <li key={p.id}>
              <button className="link" disabled={!onSelect} onClick={() => onSelect?.(p.id)}>
                {p.title}
              </button>
              {p.year ? <span className="muted small"> ({p.year})</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function RelationsTab({
  paperId,
  onOpenCandidates,
  onSelectPaper
}: {
  paperId: string
  onOpenCandidates?: (paperId: string) => void
  onSelectPaper?: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<RelationsDetail | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [updating, setUpdating] = useState(false)

  const refresh = useCallback(() => {
    window.research.map.relations(paperId).then(setDetail, () => undefined)
  }, [paperId])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)

  const update = (): void => {
    setUpdating(true)
    void window.research.citations.update([paperId]).then(
      (r) => {
        setUpdating(false)
        setNotice(r.ok ? { error: false, text: t('relations.update_queued') } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setUpdating(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  if (!detail) return <div className="center muted">{t('relations.loading')}</div>
  const state = citationsState(detail.citations)

  return (
    <div className="relations-tab">
      <section className="card">
        <div className="row small">
          <strong>{t('relations.citations_title')}</strong>
          {state === 'unresolved' ? (
            <span className="badge badge-no_citations">{t('badges.no_citations')}</span>
          ) : (
            <span className="muted">
              {state === 'ok'
                ? t('relations.state.ok', { date: new Date(detail.citations!.fetched_at).toLocaleDateString(), count: detail.citations!.cited_by_count ?? 0 })
                : t('relations.state.none')}
            </span>
          )}
          <button className="small" disabled={updating} onClick={update}>
            {t('relations.update')}
          </button>
        </div>
        {state === 'unresolved' && <p className="muted small">{t('relations.unresolved_help')}</p>}
      </section>
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      <PaperLinks title={t('relations.cites')} papers={detail.cites} onSelect={onSelectPaper} />
      <PaperLinks title={t('relations.cited_by')} papers={detail.citedBy} onSelect={onSelectPaper} />
      {detail.externalReferences > 0 && (
        <p className="small">
          {t('relations.external', { count: detail.externalReferences })}{' '}
          {onOpenCandidates && (
            <button className="link" onClick={() => onOpenCandidates(paperId)}>
              {t('relations.see_candidates')}
            </button>
          )}
        </p>
      )}
      <section>
        <h3>{t('relations.similar')}</h3>
        {detail.similar.length === 0 ? (
          <p className="muted small">{t('relations.no_similar')}</p>
        ) : (
          <ul className="relations-list">
            {detail.similar.map((s) => (
              <li key={s.id}>
                <button className="link" disabled={!onSelectPaper} onClick={() => onSelectPaper?.(s.id)}>
                  {s.title}
                </button>
                <span className="muted small">
                  {' '}
                  {[s.year, scorePercent(s.score)].filter(Boolean).join(' · ')}
                </span>
                <div className="muted small">{reasonsText(t, s.reasons)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
