import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActionResult } from '../../../shared/ipc'
import type { PaperDetail } from '../../../shared/library'
import type { Evidence, FieldStatus, ReviewItem, SummaryFieldKey, ThesisContext } from '../../../shared/summary'
import { findInNormalized, normalizeForMatch } from '../../../shared/textMatch'
import { useEvent } from '../../hooks/useEvent'
import { errorText } from '../../lib/errorText'
import { afterResolve, current, next, prev, progressLabel, type ReviewCursor } from '../../lib/reviewQueue'
import { FacetCard } from '../summary/FacetCard'
import { formatDate, type OpenEvidence, type Origin, type RunAction } from '../summary/FieldCard'
import { PdfViewer } from '../paper/PdfViewer'
import { ThesisCard } from '../summary/ThesisCard'
import { FieldCard } from '../summary/FieldCard'

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
    if (!needsPassage) {
      setPassage(null)
      return
    }
    let alive = true
    window.research.summary.pageText(detail.id, evidence?.page ?? null).then((text) => {
      if (alive) setPassage(text)
    })
    return () => {
      alive = false
    }
  }, [needsPassage, detail.id, evidence?.page])

  if (needsPassage) {
    const normalized = normalizeForMatch(passage ?? '')
    const match = evidence ? findInNormalized(normalizeForMatch(evidence.quote), normalized) : null
    const label = evidence?.page != null ? t('review.passage', { page: evidence.page }) : t('review.passage_web')
    return (
      <div className="review-passage">
        {detail.hasPdf && focusResult === false && <p className="banner warning">{t('review.quote_not_in_pdf')}</p>}
        <p className="muted small">{label}</p>
        <p className="card-text">
          {match ? (
            <>
              {normalized.slice(0, match.start)}
              <mark>{normalized.slice(match.start, match.end)}</mark>
              {normalized.slice(match.end)}
            </>
          ) : (
            normalized
          )}
        </p>
      </div>
    )
  }

  if (pdf) return <PdfViewer data={pdf} focus={evidence?.page != null ? { page: evidence.page, quote: evidence.quote } : undefined} onFocusResult={setFocusResult} />
  return <div className="center muted">{t('paper.pdf_loading')}</div>
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Review mode: cycles through generated fields, facets and the thesis relation across the given papers. */
export function ReviewView({ ids, onExit }: { ids?: string[]; onExit: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState<ReviewCursor | null>(null)
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [thesis, setThesis] = useState<ThesisContext | null>(null)
  const [manualEvidence, setManualEvidence] = useState<Picked | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

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
    window.research.library.detail(id).then(setDetail, () => setDetail(null))
  }

  useEffect(() => {
    setManualEvidence(null)
    if (item) refreshDetail(item.paperId)
    else setDetail(null)
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
        const fresh = await window.research.library.detail(item.paperId)
        setDetail(fresh)
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
    for (const button of Array.from(buttons)) if (button.textContent === label) button.click()
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
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
          onExit()
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

  if (!item || !detail) {
    return (
      <div className="review-view review-empty">
        <p className="muted">{t('review.empty')}</p>
        <button onClick={onExit}>{t('review.exit')}</button>
      </div>
    )
  }

  const entry = entryOf(detail, item)
  const evidence = manualEvidence ?? (entry ? pickEvidence(entry.evidence) : null)
  const onOpenEvidence: OpenEvidence = (page, quote) => setManualEvidence({ page, quote })
  const fallback: Origin = detail.summary ? { model: detail.summary.generated.model, at: detail.summary.generated.at } : { model: '', at: '' }
  const progress = progressLabel(cursor)

  return (
    <div className="review-view">
      <div className="review-left">
        <div className="row small">
          <strong>{t('review.progress', { position: progress.position, total: progress.total, title: item.title })}</strong>
          <button onClick={onExit}>{t('review.exit')}</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        <div ref={cardRef}>{renderCard(item, detail, entry, thesis, fallback, onOpenEvidence, run)}</div>
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
  if (item.section === 'fields') {
    if (!detail.summary) return null
    const key = item.key as SummaryFieldKey
    const card = { key, entry: detail.summary.fields[key] } as Parameters<typeof FieldCard>[0]['card']
    return <FieldCard paperId={detail.id} card={card} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
  }
  if (item.section === 'facets') {
    const def = detail.form?.facets.find((f) => f.key === item.key)
    if (!def) return null
    return (
      <FacetCard paperId={detail.id} def={def} entry={(entry as never) ?? null} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
    )
  }
  const relation = detail.extraction?.thesis_relation
  if (!relation) return null
  return (
    <ThesisCard paperId={detail.id} relation={relation} questions={thesis?.research_questions ?? []} fallback={fallback} onOpenEvidence={onOpenEvidence} run={run} />
  )
}
