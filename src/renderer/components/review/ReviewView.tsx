import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import type { Evidence, FieldStatus, ReviewItem, SummaryFieldKey, ThesisContext } from '../../../shared/summary'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { afterResolve, current, next, prev, progressLabel, reinsert, type ReviewCursor } from '../../lib/reviewQueue'
import { UNDO_MS } from '../../lib/typedRelations'
import { FacetCard } from '../summary/FacetCard'
import { type OpenEvidence, type Origin, type RunAction } from '../summary/FieldCard'
import { FieldCard } from '../summary/FieldCard'
import { ThesisCard } from '../summary/ThesisCard'
import { EvidencePanel, pickEvidence, type Picked } from './EvidencePanel'
import { RelationReview, type RelationKeys } from './RelationReview'

function entryOf(detail: PaperDetail, item: ReviewItem): { status: FieldStatus; evidence: Evidence[] } | null {
  if (item.section === 'fields') return detail.summary?.fields[item.key as SummaryFieldKey] ?? null
  if (item.section === 'facets') return detail.extraction?.facets[item.key] ?? null
  return detail.extraction?.thesis_relation ?? null
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function Shell({ progress, title, onExit, children }: { progress: { position: number; total: number }; title: string; onExit: () => void; children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="review-view">
      <div className="review-left">
        <div className="row small">
          <strong>{t('review.progress', { position: progress.position, total: progress.total, title })}</strong>
          <button onClick={onExit}>{t('review.exit')}</button>
        </div>
        {children}
        <p className="muted small">{t('review.shortcuts')}</p>
      </div>
      <div className="review-right" />
    </div>
  )
}

/** Review mode: cycles through generated fields, facets and the thesis relation across the given papers. */
export function ReviewView({ ids, onExit }: { ids?: string[]; onExit: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState<ReviewCursor | null>(null)
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [manualEvidence, setManualEvidence] = useState<Picked | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // Guards against an out-of-order `library.detail` response (e.g. the user pressed → twice)
  // overwriting a newer one.
  const requestRef = useRef(0)
  const relationKeys = useRef<RelationKeys | null>(null)
  // The last relation decision (its main-process undo token) while its "Deshacer" notice is shown.
  const [undo, setUndo] = useState<{ token: string; item: ReviewItem } | null>(null)
  const [undoing, setUndoing] = useState(false)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    []
  )

  useEffect(() => {
    window.research.summary.reviewQueue(ids).then(
      (items) => setCursor({ items, index: 0 }),
      () => setCursor({ items: [], index: 0 })
    )
    // Only the initial set of ids matters: the queue is then tracked locally via the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const item = cursor ? current(cursor) : null
  // The key handler is registered once: it reads the current item and the undo action through refs.
  const itemRef = useRef<ReviewItem | null>(null)
  itemRef.current = item

  useEffect(() => {
    window.research.thesis.get().then(setThesis, () => setThesis(null))
  }, [])

  const refreshDetail = (id: string): void => {
    const reqId = ++requestRef.current
    window.research.library.detail(id).then(
      (d) => {
        if (requestRef.current === reqId) {
          setDetail(d)
          setDetailFailed(false)
        }
      },
      () => {
        if (requestRef.current === reqId) {
          setDetail(null)
          setDetailFailed(true)
        }
      }
    )
  }

  useEffect(() => {
    setManualEvidence(null)
    if (item && item.section !== 'relation') refreshDetail(item.paperId)
    else {
      requestRef.current++ // invalidate any in-flight fetch for a now-gone item
      setDetail(null)
      setDetailFailed(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.paperId, item?.section, item?.key])

  useEvent('library-changed', () => {
    if (item && item.section !== 'relation') refreshDetail(item.paperId)
  })

  const run: RunAction = async (action: () => Promise<ActionResult>) => {
    setError(null)
    try {
      const result = await action()
      if (!result.ok) {
        setError(errorText(t, result.error))
        return false
      }
      if (item) {
        const reqId = ++requestRef.current
        const fresh = await window.research.library.detail(item.paperId)
        if (requestRef.current !== reqId) return true
        setDetail(fresh)
        setDetailFailed(false)
        const entry = entryOf(fresh, item)
        // Verifying or saving an edit leaves the entry's status something other than 'generated',
        // which is exactly the review queue's own criterion for membership: resolve it then.
        if (entry && entry.status !== 'generated') setCursor((c) => (c ? afterResolve(c, item) : c))
      }
      return true
    } catch {
      setError(errorText(t, 'unknown'))
      return false
    }
  }

  const clearUndo = (): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    setUndo(null)
  }

  /** A relation was confirmed, rejected, retyped or reversed: it leaves the queue and can be undone for a few seconds. */
  const decided =
    (decidedItem: ReviewItem) =>
    (token: string): void => {
      setCursor((c) => (c ? afterResolve(c, decidedItem) : c))
      setError(null)
      clearUndo()
      setUndo({ token, item: decidedItem })
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
    }

  /** Undoes the last relation decision while its notice is shown; false when there is none. */
  const undoLast = (): boolean => {
    if (!undo) return false
    if (undoing) return true
    const last = undo
    setUndoing(true)
    setError(null)
    // The token stays until the undo succeeds (or the notice expires), so a failed undo can be retried.
    window.research.relations.revert(last.token).then(
      (r) => {
        setUndoing(false)
        if (r.ok) {
          setUndo((u) => (u?.token === last.token ? null : u))
          if (undoTimer.current) clearTimeout(undoTimer.current)
          undoTimer.current = null
          setCursor((c) => (c ? reinsert(c, last.item) : c))
        } else setError(errorText(t, r.error))
      },
      () => {
        setUndoing(false)
        setError(errorText(t, 'unknown'))
      }
    )
    return true
  }
  const undoRef = useRef(undoLast)
  undoRef.current = undoLast

  const click = (label: string): void => {
    const buttons = cardRef.current?.querySelectorAll('button') ?? []
    for (const button of Array.from(buttons)) {
      if (button.textContent === label) {
        button.click()
        return
      }
    }
  }

  const editing = (): boolean => cardRef.current?.querySelector('.editor') !== null

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const active = document.activeElement
      if (active && (EDITABLE.has(active.tagName) || (active as HTMLElement).isContentEditable)) return
      const relation = itemRef.current?.section === 'relation' ? relationKeys.current : null
      switch (e.key) {
        case 'v':
        case 'V':
          if (relation) relation.confirm()
          else click(t('summary.verify'))
          break
        case 'r':
        case 'R':
          if (!relation) return
          relation.reject()
          break
        case 'u':
        case 'U':
          // U first undoes a recent relation decision; otherwise, on a summary item, it unverifies.
          if (!undoRef.current() && itemRef.current?.section !== 'relation') click(t('summary.unverify'))
          break
        case 'e':
        case 'E':
          if (relation) relation.toggleTypes()
          else click(t('summary.edit'))
          break
        case 'ArrowRight':
          setCursor((c) => (c ? next(c) : c))
          break
        case 'ArrowLeft':
          setCursor((c) => (c ? prev(c) : c))
          break
        case 'Escape':
          // An open type list or editor owns Esc first; only exit when none is open.
          if (relation?.closeTypes()) break
          if (!editing()) onExit()
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [t, onExit])

  if (!cursor) return <div className="center muted">{t('app.loading')}</div>

  const undoBanner = undo && (
    <div className="banner">
      <span>{t('review.decided')}</span>
      <button className="small" disabled={undoing} onClick={() => undoLast()}>
        {t('typed.undo')}
      </button>
    </div>
  )

  if (!item) {
    return (
      <div className="review-view review-empty">
        <p className="muted">{t('review.empty')}</p>
        {error && <div className="banner error">{error}</div>}
        {undoBanner}
        <button onClick={onExit}>{t('review.exit')}</button>
      </div>
    )
  }

  const progress = progressLabel(cursor)

  if (item.section === 'relation') {
    return (
      <RelationReview
        key={`${item.paperId}/${item.key}`}
        item={item}
        keys={relationKeys}
        onDecided={decided(item)}
        header={
          <>
            <div className="row small">
              <strong>{t('review.progress', { position: progress.position, total: progress.total, title: item.title })}</strong>
              <button onClick={onExit}>{t('review.exit')}</button>
            </div>
            {error && <div className="banner error">{error}</div>}
          </>
        }
        footer={
          <>
            {undoBanner}
            <p className="muted small">{t('review.relation_shortcuts')}</p>
          </>
        }
      />
    )
  }

  if (detailFailed) {
    return (
      <Shell progress={progress} title={item.title} onExit={onExit}>
        <div className="banner error">{errorText(t, 'unknown')}</div>
        {undoBanner}
      </Shell>
    )
  }

  // Never render the cards (or the evidence panel) against a detail for a different paper, or
  // against a stale one still being replaced.
  if (!detail || detail.id !== item.paperId) {
    return (
      <Shell progress={progress} title={item.title} onExit={onExit}>
        <p className="muted">{t('app.loading')}</p>
        {undoBanner}
      </Shell>
    )
  }

  const entry = entryOf(detail, item)
  const evidence = manualEvidence ?? (entry ? pickEvidence(entry.evidence) : null)
  const onOpenEvidence: OpenEvidence = (page, quote) => setManualEvidence({ page, quote })
  const fallback: Origin = detail.summary ? { model: detail.summary.generated.model, at: detail.summary.generated.at } : { model: '', at: '' }
  const card = renderCard(item, detail, entry, thesis, fallback, onOpenEvidence, run)

  return (
    <div className="review-view">
      <div className="review-left">
        <div className="row small">
          <strong>{t('review.progress', { position: progress.position, total: progress.total, title: item.title })}</strong>
          <button onClick={onExit}>{t('review.exit')}</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        <div ref={cardRef}>{card ?? <p className="muted">{t('review.item_unavailable')}</p>}</div>
        {undoBanner}
        <p className="muted small">{t('review.shortcuts')}</p>
      </div>
      <div className="review-right">
        <EvidencePanel detail={detail} evidence={evidence} />
      </div>
    </div>
  )
}

function renderCard(
  item: ReviewItem,
  detail: PaperDetail,
  entry: { status: FieldStatus; evidence: Evidence[] } | null,
  thesis: ThesisContext | null,
  fallback: Origin,
  onOpenEvidence: OpenEvidence,
  run: RunAction
): React.JSX.Element | null {
  // Keyed by the item's full identity so switching to another field/facet/paper never reuses a
  // mounted card's component state (an open editor, an unsaved draft).
  const key = `${item.paperId}/${item.section}/${item.key}`
  if (item.section === 'fields') {
    if (!detail.summary) return null
    const fieldKey = item.key as SummaryFieldKey
    const card = { key: fieldKey, entry: detail.summary.fields[fieldKey] } as Parameters<typeof FieldCard>[0]['card']
    return <FieldCard key={key} paperId={detail.id} card={card} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
  }
  if (item.section === 'facets') {
    const def = detail.form?.facets.find((f) => f.key === item.key)
    if (!def) return null
    return <FacetCard key={key} paperId={detail.id} def={def} entry={(entry as never) ?? null} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
  }
  const relation = detail.extraction?.thesis_relation
  if (!relation) return null
  return (
    <ThesisCard key={key} paperId={detail.id} outdated={detail.thesisOutdated} relation={relation} questions={thesis?.research_questions ?? []} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
  )
}
