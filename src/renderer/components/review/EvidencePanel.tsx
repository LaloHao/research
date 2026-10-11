import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaperDetail } from '../../../shared/library'
import type { Evidence } from '../../../shared/summary'
import { locateInOriginal } from '../../../shared/textMatch'
import { errorText } from '../../lib/errorText'
import { blockSegments, paragraphSegments } from '../../lib/passage'
import { reflowPage, type Block } from '../../lib/reflow'
import { ContentView, type ContentFocus } from '../paper/ContentView'
import { PdfViewer } from '../paper/PdfViewer'
import { pdfjs } from '../paper/pdfjs'
import { readPageText, runningLines } from '../paper/pdfText'

export type Picked = { page: number | null; quote: string }

/** The first citation with a page, or the first citation at all when none has one. */
export function pickEvidence(evidence: Evidence[]): Picked | null {
  if (evidence.length === 0) return null
  const withPage = evidence.find((e) => e.page !== null)
  return withPage ? { page: withPage.page, quote: withPage.quote } : { page: evidence[0].page, quote: evidence[0].quote }
}

type LoadedPdf = { id: string; data: Uint8Array }
/** The evidence PDF opened for reading its text, tied to the bytes it was opened from. */
type OpenedPdf = { source: LoadedPdf; status: 'ready'; doc: PDFDocumentProxy; repeated: Set<string> } | { source: LoadedPdf; status: 'error' }
/** The evidence page reflowed, tied to the paper and page it was read for. */
type Reflowed = { key: string; status: 'ready'; blocks: Block[] } | { key: string; status: 'error' }

/**
 * Right-hand panel: the PDF (highlighting the quote) when available. Otherwise the passage,
 * formatted: a web paper's content (with the quote highlighted), or, when the quote is not found
 * in the PDF, the evidence page reflowed like the Texto tab. The indexed page text (whitespace
 * collapsed) is the last resort, for a PDF that fails to load or a paper with neither.
 */
export function EvidencePanel({ detail, evidence }: { detail: PaperDetail; evidence: Picked | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [focusResult, setFocusResult] = useState<boolean | null>(null)
  const [opened, setOpened] = useState<OpenedPdf | null>(null)
  const [reflowed, setReflowed] = useState<Reflowed | null>(null)
  const [passage, setPassage] = useState<string | null>(null)
  const [passageFailed, setPassageFailed] = useState(false)

  useEffect(() => {
    setPdf(null)
    setPdfFailed(false)
    setFocusResult(null)
    if (!detail.hasPdf) return
    const id = detail.id
    let alive = true
    window.research.library.readPdf(id).then(
      (result) => {
        if (!alive) return
        if (result.ok && result.data) setPdf({ id, data: result.data })
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

  useEffect(() => setFocusResult(null), [detail.id, evidence?.page, evidence?.quote])

  const page = evidence?.page ?? null
  const quote = evidence?.quote ?? ''
  // The bytes are checked against the paper shown, since they are only cleared once the effect above runs.
  const currentPdf = pdf !== null && pdf.id === detail.id ? pdf : null
  const showContent = !detail.hasPdf && !!detail.content
  const wantReflow = currentPdf !== null && focusResult === false && page !== null
  const reflowKey = `${detail.id}:${page}`

  // Opens the already-read bytes again for their text, rather than reading the PDF a second time.
  useEffect(() => {
    setOpened(null)
    if (!wantReflow || !currentPdf) return
    const source = currentPdf
    let alive = true
    const task = pdfjs.getDocument({ data: source.data.slice() })
    task.promise
      .then(async (doc) => {
        if (!alive) return
        const repeated = await runningLines(source.id, doc)
        if (alive) setOpened({ source, status: 'ready', doc, repeated })
      })
      .catch(() => {
        if (alive) setOpened({ source, status: 'error' })
      })
    return () => {
      alive = false
      void task.destroy()
    }
  }, [wantReflow, currentPdf])

  const openedDoc = wantReflow && opened?.source === currentPdf && opened.status === 'ready' ? opened : null
  useEffect(() => {
    if (!openedDoc || page === null) return
    const key = reflowKey
    let alive = true
    readPageText(openedDoc.doc, page).then(
      (text) => {
        if (alive) setReflowed({ key, status: 'ready', blocks: reflowPage(text, openedDoc.repeated) })
      },
      () => {
        if (alive) setReflowed({ key, status: 'error' })
      }
    )
    return () => {
      alive = false
    }
  }, [openedDoc, page, reflowKey])

  const blocks = wantReflow && reflowed?.key === reflowKey && reflowed.status === 'ready' ? reflowed.blocks : null
  // A PDF that can't be reread, a page that can't be read or one with no text falls back to the indexed text.
  const reflowFailed =
    wantReflow &&
    ((opened?.source === currentPdf && opened.status === 'error') || (reflowed?.key === reflowKey && (reflowed.status === 'error' || reflowed.blocks.length === 0)))
  const needsPassage = !detail.hasPdf || pdfFailed || focusResult === false
  const needsPageText = needsPassage && !showContent && !(wantReflow && !reflowFailed)

  useEffect(() => {
    // Cleared up front (not just on success) so a slow fetch for a new page never shows the
    // previous page's passage while it is in flight.
    setPassage(null)
    setPassageFailed(false)
    if (!needsPageText) return
    let alive = true
    window.research.summary.pageText(detail.id, page).then(
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
  }, [needsPageText, detail.id, page])

  const contentFocus = useMemo<ContentFocus | null>(() => (quote ? { quote, seq: 0 } : null), [quote])

  if (needsPassage) {
    // pdf.js could not open the PDF at all: say so, rather than that the quote was not found in it.
    const unreadable = wantReflow && opened?.source === currentPdf && opened.status === 'error'
    const notice =
      detail.hasPdf &&
      focusResult === false &&
      (unreadable ? <p className="banner warning">{errorText(t, 'unreadable_pdf')}</p> : <p className="banner warning">{t('review.quote_not_in_pdf')}</p>)
    if (showContent) {
      return (
        <div className="review-passage">
          <p className="muted small">{t('review.passage_content')}</p>
          <ContentView key={detail.id} content={detail.content ?? ''} focus={contentFocus} />
        </div>
      )
    }
    if (!needsPageText) {
      return (
        <div className="review-passage">
          <p className="banner warning">{t('review.quote_not_in_pdf_reflow')}</p>
          <p className="muted small">{t('review.passage_pdf', { page })}</p>
          {blocks ? <ReflowedPassage blocks={blocks} quote={quote} /> : <p className="muted">{t('review.passage_loading')}</p>}
        </div>
      )
    }
    const label = page != null ? t('review.passage', { page }) : t('review.passage_web')
    return (
      <div className="review-passage">
        {notice}
        <p className="muted small">{label}</p>
        {passageFailed ? (
          <p className="banner error">{errorText(t, 'unknown')}</p>
        ) : passage === null ? (
          <p className="muted">{t('review.passage_loading')}</p>
        ) : (
          renderPassage(passage, evidence)
        )}
      </div>
    )
  }

  if (currentPdf) return <PdfViewer data={currentPdf.data} focus={page != null ? { page, quote } : undefined} onFocusResult={setFocusResult} />
  return <div className="center muted">{t('paper.pdf_loading')}</div>
}

/** The evidence page reflowed (headings, paragraphs, dimmed margins), the quote marked wherever it falls and scrolled into view. */
function ReflowedPassage({ blocks, quote }: { blocks: Block[]; quote: string }): React.JSX.Element {
  const segments = useMemo(
    () =>
      blockSegments(
        blocks.map((b) => b.text),
        quote
      ),
    [blocks, quote]
  )
  const firstMarkRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    firstMarkRef.current?.scrollIntoView({ block: 'center' })
  }, [segments])

  let marked = false
  return (
    <div className="text-view">
      {blocks.map((block, i) => {
        const content = segments[i].map((seg, j) => {
          if (!seg.marked) return seg.text
          const first = !marked
          marked = true
          return (
            <mark key={j} ref={first ? firstMarkRef : undefined}>
              {seg.text}
            </mark>
          )
        })
        if (block.kind === 'heading') return <h3 key={i}>{content}</h3>
        if (block.kind === 'margin')
          return (
            <p key={i} className="text-margin">
              {content}
            </p>
          )
        return <p key={i}>{content}</p>
      })}
    </div>
  )
}

/** Shows the passage as written (case, accents and paragraph breaks kept), the quote marked at its real position. */
function renderPassage(passage: string, evidence: Picked | null): React.ReactNode {
  const match = evidence ? locateInOriginal(evidence.quote, passage) : null
  return (
    <>
      {paragraphSegments(passage, match).map((segments, i) => (
        <p key={i} className="card-text passage-paragraph">
          {segments.map((seg, j) => (seg.marked ? <mark key={j}>{seg.text}</mark> : seg.text))}
        </p>
      ))}
    </>
  )
}
