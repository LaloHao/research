import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RelationDecisionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import type { ReviewItem } from '../../../shared/summary'
import type { RelationType, RelationView } from '../../../shared/typedRelations'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { availableTypes, chipTextColor, firstEvidence, isDirected, relationSentence, TYPE_COLORS } from '../../lib/typedRelations'
import { EvidencePanel } from './EvidencePanel'

/** What the review shortcuts do on a relation item: V, R, E (type list) and Esc (closes the list first). */
export interface RelationKeys {
  confirm(): void
  reject(): void
  toggleTypes(): void
  /** True when the type list was open (and is now closed). */
  closeTypes(): boolean
}

type Loaded = { key: string; relation: RelationView | null; all: RelationView[]; details: Record<string, PaperDetail> }

/** One suggested relation: the card on the left, the evidence of both papers side by side on the right. */
export function RelationReview({
  item,
  header,
  footer,
  keys,
  onDecided
}: {
  item: ReviewItem
  header: React.ReactNode
  footer: React.ReactNode
  keys: React.RefObject<RelationKeys | null>
  onDecided: (undoToken: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choosingType, setChoosingType] = useState(false)
  const firstTypeRef = useRef<HTMLButtonElement>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const token = ++request.current
    const key = item.key
    void (async () => {
      const relations = await window.research.relations.forPaper(item.paperId)
      const all = [...relations.suggested, ...relations.confirmed, ...relations.rejected]
      const relation = all.find((r) => r.id === key) ?? null
      const details: Record<string, PaperDetail> = {}
      if (relation) for (const id of [relation.from, relation.to]) details[id] = await window.research.library.detail(id)
      if (token === request.current) {
        setLoaded({ key, relation, all, details })
        setFailed(false)
      }
    })().catch(() => {
      if (token === request.current) setFailed(true)
    })
  }, [item.paperId, item.key])
  useEffect(load, [load])
  useEvent('library-changed', load)
  useEffect(() => {
    if (choosingType) firstTypeRef.current?.focus()
  }, [choosingType])

  const current = loaded?.key === item.key ? loaded : null
  // Only a relation still waiting for review can be decided here; one decided elsewhere shows as unavailable.
  const pending = current?.relation?.status === 'suggested' ? current.relation : null
  const titleOf = (id: string): string => current?.details[id]?.paper?.title ?? id
  const types = pending && current ? availableTypes(pending, current.all) : []

  const decide = (action: () => Promise<RelationDecisionResult>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    action().then(
      (r) => {
        setBusy(false)
        if (r.ok) {
          // The type list closes only once the decision is saved; a failed one leaves it open to retry.
          setChoosingType(false)
          onDecided(r.undoToken)
        } else setError(errorText(t, r.error))
      },
      () => {
        setBusy(false)
        setError(errorText(t, 'unknown'))
      }
    )
  }
  const confirm = (): void => {
    if (pending) decide(() => window.research.relations.setStatus(pending.id, 'confirmed'))
  }
  const reject = (): void => {
    if (pending) decide(() => window.research.relations.setStatus(pending.id, 'rejected'))
  }
  const changeType = (type: RelationType): void => {
    if (pending) decide(() => window.research.relations.changeType(pending.id, type))
  }
  const reverse = (): void => {
    if (pending) decide(() => window.research.relations.reverse(pending.id))
  }

  // Re-registered after every render so the shortcuts always act on the latest relation and state.
  useEffect(() => {
    keys.current = pending
      ? {
          confirm,
          reject,
          toggleTypes: () => setChoosingType((open) => !open && types.length > 0),
          closeTypes: () => {
            if (!choosingType) return false
            setChoosingType(false)
            return true
          }
        }
      : null
    return () => {
      keys.current = null
    }
  })

  let left: React.ReactNode
  if (failed) left = <div className="banner error">{errorText(t, 'unknown')}</div>
  else if (!current) left = <p className="muted">{t('app.loading')}</p>
  else if (!pending) left = <p className="muted">{t('review.item_unavailable')}</p>
  else
    left = (
      <div className="typed-card">
        <div className="row small">
          <span className="chip type-chip" style={{ background: TYPE_COLORS[pending.type], color: chipTextColor(TYPE_COLORS[pending.type]) }}>
            {t(`typed.types.${pending.type}`)}
          </span>
        </div>
        <p>
          <strong>{relationSentence(t, pending, titleOf)}</strong>
        </p>
        <p className="card-text">{pending.justification}</p>
        {[pending.from, pending.to].map((id) => {
          const quotes = pending.evidence.filter((e) => e.paper === id)
          return quotes.length ? (
            <div key={id}>
              <p className="muted small">{t('typed.evidence_in', { title: titleOf(id) })}</p>
              <ul className="evidence">
                {quotes.map((e, i) => (
                  <li key={i} className={e.found ? '' : 'not-found'}>
                    <q>{e.quote}</q>
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        })}
        {error && <div className="banner error">{error}</div>}
        <div className="row card-actions">
          <button className="small" disabled={busy} onClick={confirm}>
            {t('typed.confirm')}
          </button>
          <button className="small" disabled={busy} onClick={reject}>
            {t('typed.reject')}
          </button>
          {types.length > 0 && (
            <button className="small" disabled={busy} aria-expanded={choosingType} onClick={() => setChoosingType((open) => !open)}>
              {t('typed.change_type')}
            </button>
          )}
          {isDirected(pending.type) && (
            <button className="small" disabled={busy} onClick={reverse}>
              {t('typed.reverse')}
            </button>
          )}
        </div>
        {choosingType && (
          <div className="type-picker row small" role="group" aria-label={t('typed.change_type')}>
            {types.map((type, i) => (
              <button key={type} ref={i === 0 ? firstTypeRef : undefined} className="small" disabled={busy} onClick={() => changeType(type)}>
                <span className="swatch" style={{ background: TYPE_COLORS[type] }} /> {t(`typed.types.${type}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    )

  return (
    <div className="review-view">
      <div className="review-left">
        {header}
        {left}
        {footer}
      </div>
      <div className="review-right review-split">
        {pending &&
          [pending.from, pending.to].map((id) => {
            const detail = current?.details[id]
            return (
              <div key={id} className="review-pane">
                <p className="review-pane-title small">
                  <strong>{titleOf(id)}</strong>
                </p>
                {detail ? <EvidencePanel detail={detail} evidence={firstEvidence(pending.evidence, id)} /> : null}
              </div>
            )
          })}
      </div>
    </div>
  )
}
