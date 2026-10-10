import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RelationDecisionResult } from '../../../shared/ipc'
import type { PaperRelations, RelationEvidence, RelationStatus, RelationType, RelationView } from '../../../shared/typedRelations'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { availableTypes, isDirected, relationSentence, splitEvidence, TYPE_COLORS, UNDO_MS } from '../../lib/typedRelations'
import { formatDate, type OpenEvidence } from '../summary/FieldCard'

type Done = 'confirmed' | 'rejected' | 'suggested' | 'retyped' | 'reversed' | 'justified'
type Act = (action: () => Promise<RelationDecisionResult>, done: Done) => void

function Quotes({ evidence, onOpen }: { evidence: RelationEvidence[]; onOpen?: OpenEvidence }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ul className="evidence">
      {evidence.map((e, i) => (
        <li key={i} className={e.found ? '' : 'not-found'}>
          <q>{e.quote}</q>{' '}
          {onOpen && e.page !== null && (
            <button className="link small" onClick={() => onOpen(e.page!, e.quote)}>
              {t('summary.evidence_page', { page: e.page })}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function RelationCard({
  relation,
  all,
  paperId,
  title,
  busy,
  act,
  onOpenEvidence,
  onSelectPaper
}: {
  relation: RelationView
  /** Every relation of this paper, to hide the types its pair already has. */
  all: RelationView[]
  paperId: string
  title: string
  busy: boolean
  act: Act
  onOpenEvidence?: OpenEvidence
  onSelectPaper?: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(relation.justification)
  const titleOf = (id: string): string => (id === paperId ? title : id === relation.other.id ? relation.other.title : id)
  const { own, other } = splitEvidence(relation.evidence, paperId)
  const setStatus = (status: RelationStatus, done: Done): void => act(() => window.research.relations.setStatus(relation.id, status), done)
  const types = availableTypes(relation, all)
  return (
    <div className={`typed-card typed-${relation.status}`}>
      <div className="row small">
        <span className="chip type-chip" style={{ background: TYPE_COLORS[relation.type] }}>
          {t(`typed.types.${relation.type}`)}
        </span>
        {relation.edited && <span className="chip chip-edited">{t('typed.edited')}</span>}
        {relation.origin && <span className="muted">{t('typed.generated_with', { model: relation.origin.model, date: formatDate(relation.origin.at) })}</span>}
      </div>
      <p>
        <strong>{relationSentence(t, relation, titleOf)}</strong>
      </p>
      {editing ? (
        <div className="editor">
          <textarea value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <button
              className="small primary"
              disabled={busy || !draft.trim()}
              onClick={() => {
                act(() => window.research.relations.editJustification(relation.id, draft), 'justified')
                setEditing(false)
              }}
            >
              {t('summary.save')}
            </button>
            <button className="small" onClick={() => setEditing(false)}>
              {t('summary.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <p className="card-text">{relation.justification}</p>
      )}
      {own.length > 0 && (
        <>
          <p className="muted small">{t('typed.evidence_in', { title })}</p>
          <Quotes evidence={own} onOpen={onOpenEvidence} />
        </>
      )}
      {other.length > 0 && (
        <>
          <p className="muted small">
            {t('typed.evidence_in', { title: relation.other.title })}{' '}
            {onSelectPaper && (
              <button className="link small" onClick={() => onSelectPaper(relation.other.id)}>
                {t('typed.open_paper')}
              </button>
            )}
          </p>
          <Quotes evidence={other} />
        </>
      )}
      <div className="row card-actions">
        {relation.status !== 'confirmed' && (
          <button className="small" disabled={busy} onClick={() => setStatus('confirmed', 'confirmed')}>
            {t('typed.confirm')}
          </button>
        )}
        {relation.status !== 'rejected' && (
          <button className="small" disabled={busy} onClick={() => setStatus('rejected', 'rejected')}>
            {t('typed.reject')}
          </button>
        )}
        {relation.status === 'confirmed' && (
          <button className="small" disabled={busy} onClick={() => setStatus('suggested', 'suggested')}>
            {t('typed.back_to_suggested')}
          </button>
        )}
        {relation.status === 'rejected' && (
          <button className="small" disabled={busy} onClick={() => setStatus('suggested', 'suggested')}>
            {t('typed.restore')}
          </button>
        )}
        {relation.status !== 'rejected' && isDirected(relation.type) && (
          <button className="small" disabled={busy} onClick={() => act(() => window.research.relations.reverse(relation.id), 'reversed')}>
            {t('typed.reverse')}
          </button>
        )}
        {relation.status !== 'rejected' && !editing && (
          <button
            className="small"
            disabled={busy}
            onClick={() => {
              setDraft(relation.justification)
              setEditing(true)
            }}
          >
            {t('typed.edit_justification')}
          </button>
        )}
        {relation.status !== 'rejected' && types.length > 0 && (
          <select
            value=""
            disabled={busy}
            aria-label={t('typed.change_type')}
            onChange={(e) => {
              const next = e.target.value as RelationType | ''
              if (next) act(() => window.research.relations.changeType(relation.id, next), 'retyped')
            }}
          >
            <option value="">{t('typed.change_type')}</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {t(`typed.types.${type}`)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

/** Suggested, confirmed and (folded) rejected typed relations of one paper, with "Sugerir relaciones" and undo. */
export function TypedRelationsSection({
  paperId,
  title,
  onOpenEvidence,
  onSelectPaper
}: {
  paperId: string
  title: string
  onOpenEvidence?: OpenEvidence
  onSelectPaper?: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [data, setData] = useState<PaperRelations | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const [undo, setUndo] = useState<{ token: string; text: string } | null>(null)
  const [showRejected, setShowRejected] = useState(false)
  const request = useRef(0)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    const token = ++request.current
    window.research.relations.forPaper(paperId).then(
      (next) => {
        if (token === request.current) setData(next)
      },
      () => {
        if (token === request.current) setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }, [paperId, t])
  useEffect(refresh, [refresh])
  useEvent('library-changed', refresh)
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    []
  )

  const clearUndo = (): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    setUndo(null)
  }

  const act: Act = (action, done) => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    action().then(
      (r) => {
        setBusy(false)
        if (!r.ok) return setNotice({ error: true, text: errorText(t, r.error) })
        clearUndo()
        setUndo({ token: r.undoToken, text: t(`typed.done.${done}`) })
        undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const revert = (): void => {
    if (!undo || busy) return
    const { token } = undo
    clearUndo()
    setBusy(true)
    window.research.relations.revert(token).then(
      (r) => {
        setBusy(false)
        if (!r.ok) setNotice({ error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  const suggest = (): void => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    window.research.relations.suggest(paperId).then(
      (r) => {
        setBusy(false)
        setNotice(r.ok ? { error: false, text: t('typed.suggest_queued') } : { error: true, text: errorText(t, r.error) })
      },
      () => {
        setBusy(false)
        setNotice({ error: true, text: errorText(t, 'unknown') })
      }
    )
  }

  if (!data) return <p className="muted small">{t('relations.loading')}</p>
  const all = [...data.suggested, ...data.confirmed, ...data.rejected]
  const card = (r: RelationView): React.JSX.Element => (
    <RelationCard key={r.id} relation={r} all={all} paperId={paperId} title={title} busy={busy} act={act} onOpenEvidence={onOpenEvidence} onSelectPaper={onSelectPaper} />
  )

  return (
    <section className="typed-relations">
      <h3>{t('typed.title')}</h3>
      <div className="row small">
        <button className="small" disabled={busy || data.candidates === 0} onClick={suggest}>
          {t(all.length > 0 ? 'typed.suggest_again' : 'typed.suggest')}
        </button>
        <span className="muted">
          {data.candidates === 0 ? t('typed.no_candidates') : data.needsAnalysis ? t('typed.pending', { count: data.candidates }) : t('typed.up_to_date')}
        </span>
      </div>
      {notice && <div className={`banner${notice.error ? ' error' : ''}`}>{notice.text}</div>}
      {undo && (
        <div className="banner">
          <span>{undo.text}</span>
          <button className="small" disabled={busy} onClick={revert}>
            {t('typed.undo')}
          </button>
        </div>
      )}
      <h4>{t('typed.suggested')}</h4>
      {data.suggested.length ? data.suggested.map(card) : <p className="muted small">{t('typed.none_suggested')}</p>}
      <h4>{t('typed.confirmed')}</h4>
      {data.confirmed.length ? data.confirmed.map(card) : <p className="muted small">{t('typed.none_confirmed')}</p>}
      {data.rejected.length > 0 && (
        <details open={showRejected} onToggle={(e) => setShowRejected((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t('typed.rejected', { count: data.rejected.length })}</summary>
          {data.rejected.map(card)}
        </details>
      )}
    </section>
  )
}
