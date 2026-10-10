import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import type { Evidence, FieldStatus, ReviewItem, SummaryFieldKey, ThesisContext } from '../../../shared/summary'
import { locateInOriginal } from '../../../shared/textMatch'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { paragraphSegments } from '../../lib/passage'
import { afterResolve, current, next, prev, progressLabel, type ReviewCursor } from '../../lib/reviewQueue'
import { FacetCard } from '../summary/FacetCard'
import { type OpenEvidence, type Origin, type RunAction } from '../summary/FieldCard'
import { FieldCard } from '../summary/FieldCard'
import { PdfViewer } from '../paper/PdfViewer'
import { ThesisCard } from '../summary/ThesisCard'

type Picked = { page: number | null; quote: string }

/** The first citation with a page, or the first citation at all when none has one. */
function pickEvidence(evidence: Evidence[]): Picked | null {
  if (evidence.length === 0) return null
  const withPage = evidence.find((e) => e.page !== null)
  return withPage ? { page: withPage.page, quote: withPage.quote } : { page: evidence[0].page, quote: evidence[0].quote }
}

function entryOf(detail: PaperDetail, item: ReviewItem): { status: FieldStatus; evidence: Evidence[] } | null {
  if (item.section === 'fields') return detail.summary?.fields[item.key as SummaryFieldKey] ?? null
  if (item.section === 'facets') return detail.extraction?.facets[item.key] ?? null
  return detail.extraction?.thesis_relation ?? null
}

/** Right-hand panel: the PDF (highlighting the quote) when available, otherwise the extracted passage. */
function EvidencePanel({ detail, evidence }: { detail: PaperDetail; evidence: Picked | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [focusResult, setFocusResult] = useState<boolean | null>(null)
  const [passage, setPassage] = useState<string | null>(null)
  const [passageFailed, setPassageFailed] = useState(false)

  useEffect(() => {
    setPdf(null)
    setPdfFailed(false)
    setFocusResult(null)
    if (!detail.hasPdf) return
    let alive = true
    window.research.library.readPdf(detail.id).then(
      (result) => {
        if (!alive) return
        if (result.ok && result.data) setPdf(result.data)
        else setPdfFailed(true)
      },
      () => {
        if (alive) setPdfFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [detail.id, detail.hasPdf])

  useEffect(() => setFocusResult(null), [evidence?.page, evidence?.quote])

  const needsPassage = !detail.hasPdf || pdfFailed || focusResult === false
  useEffect(() => {
    // Cleared up front (not just on success) so a slow fetch for a new page never shows the
    // previous page's passage while it is in flight.
    setPassage(null)
    setPassageFailed(false)
    if (!needsPassage) return
    let alive = true
    window.research.summary.pageText(detail.id, evidence?.page ?? null).then(
      (text) => {
        if (alive) setPassage(text)
      },
      () => {
        if (alive) setPassageFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [needsPassage, detail.id, evidence?.page])

  if (needsPassage) {
    const label = evidence?.page != null ? t('review.passage', { page: evidence.page }) : t('review.passage_web')
    return (
      <div className="review-passage">
        {detail.hasPdf && focusResult === false && <p className="banner warning">{t('review.quote_not_in_pdf')}</p>}
        <p className="muted small">{label}</p>
        {passageFailed ? (
          <p className="banner error">{errorText(t, 'unknown')}</p>
        ) : (
          renderPassage(passage, evidence)
        )}
      </div>
    )
  }

  if (pdf) return <PdfViewer data={pdf} focus={evidence?.page != null ? { page: evidence.page, quote: evidence.quote } : undefined} onFocusResult={setFocusResult} />
  return <div className="center muted">{t('paper.pdf_loading')}</div>
}

/** Shows the passage as written (case, accents and paragraph breaks kept), the quote marked at its real position. */
function renderPassage(passage: string | null, evidence: Picked | null): React.ReactNode {
  const text = passage ?? ''
  const match = evidence ? locateInOriginal(evidence.quote, text) : null
  return (
    <>
      {paragraphSegments(text, match).map((segments, i) => (
        <p key={i} className="card-text passage-paragraph">
          {segments.map((seg, j) => (seg.marked ? <mark key={j}>{seg.text}</mark> : seg.text))}
        </p>
      ))}
    </>
  )
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

  useEffect(() => {
    window.research.summary.reviewQueue(ids).then(
      (items) => setCursor({ items, index: 0 }),
      () => setCursor({ items: [], index: 0 })
    )
    // Only the initial set of ids matters: the queue is then tracked locally via the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const item = cursor ? current(cursor) : null

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
    if (item) refreshDetail(item.paperId)
    else {
      requestRef.current++ // invalidate any in-flight fetch for a now-gone item
      setDetail(null)
      setDetailFailed(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.paperId, item?.section, item?.key])

  useEvent('library-changed', () => {
    if (item) refreshDetail(item.paperId)
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
      switch (e.key) {
        case 'v':
        case 'V':
          click(t('summary.verify'))
          break
        case 'u':
        case 'U':
          click(t('summary.unverify'))
          break
        case 'e':
        case 'E':
          click(t('summary.edit'))
          break
        case 'ArrowRight':
          setCursor((c) => (c ? next(c) : c))
          break
        case 'ArrowLeft':
          setCursor((c) => (c ? prev(c) : c))
          break
        case 'Escape':
          // An open editor owns Esc first (its own Cancel button); only exit when none is open.
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

  if (!item) {
    return (
      <div className="review-view review-empty">
        <p className="muted">{t('review.empty')}</p>
        <button onClick={onExit}>{t('review.exit')}</button>
      </div>
    )
  }

  const progress = progressLabel(cursor)

  if (detailFailed) {
    return (
      <Shell progress={progress} title={item.title} onExit={onExit}>
        <div className="banner error">{errorText(t, 'unknown')}</div>
      </Shell>
    )
  }

  // Never render the cards (or the evidence panel) against a detail for a different paper, or
  // against a stale one still being replaced.
  if (!detail || detail.id !== item.paperId) {
    return (
      <Shell progress={progress} title={item.title} onExit={onExit}>
        <p className="muted">{t('app.loading')}</p>
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
