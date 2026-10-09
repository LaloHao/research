import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'
import { matchSpans } from '../../lib/highlight'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfFocus = { page: number; quote: string }

/**
 * Renders every page to a canvas, fitted to the panel width. The page named by `focus` also gets
 * a text layer with the matching spans highlighted and scrolled into view; `onFocusResult` reports
 * whether the quote was found there (the caller falls back to the plain-text passage when it was
 * not, or when there is no `focus`).
 */
export function PdfViewer({
  data,
  focus,
  onFocusResult
}: {
  data: Uint8Array
  focus?: PdfFocus | null
  onFocusResult?: (found: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const pagesRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  // Kept in a ref so the drawing effect does not need to depend on the callback's identity.
  const onFocusResultRef = useRef(onFocusResult)
  onFocusResultRef.current = onFocusResult

  const focusPage = focus?.page ?? null
  const focusQuote = focus?.quote ?? null

  useEffect(() => {
    const el = pagesRef.current
    if (!el) return
    el.replaceChildren()
    setError(false)
    let cancelled = false
    // Whether the focused page was actually reached and given a text layer; if it never is
    // (the PDF errors out, or `focus.page` is past the last page) the caller still needs to hear
    // "not found" so it can fall back to the plain-text passage.
    let focusHandled = false
    const task = pdfjs.getDocument({ data: data.slice() })
    void (async () => {
      try {
        const doc = await task.promise
        const ratio = window.devicePixelRatio || 1
        const width = Math.max(el.clientWidth, 320)
        for (let n = 1; n <= doc.numPages && !cancelled; n++) {
          const page = await doc.getPage(n)
          if (cancelled) break
          const scale = width / page.getViewport({ scale: 1 }).width
          const cssViewport = page.getViewport({ scale })
          const viewport = page.getViewport({ scale: scale * ratio })

          const wrap = document.createElement('div')
          wrap.className = 'pdf-page-wrap'
          wrap.style.position = 'relative'
          wrap.style.width = `${Math.floor(cssViewport.width)}px`
          wrap.style.height = `${Math.floor(cssViewport.height)}px`
          // pdf_viewer.css computes `--total-scale-factor` (what `.textLayer` actually sizes
          // itself and its spans from) as `--scale-factor * --user-unit`, but only under the
          // `.pdfViewer .page` selector; our page container matches neither class, so both
          // custom properties must be set here directly for the text layer to line up.
          wrap.style.setProperty('--scale-factor', String(scale))
          wrap.style.setProperty('--user-unit', String(page.userUnit || 1))
          wrap.style.setProperty('--total-scale-factor', String(scale * (page.userUnit || 1)))

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
          canvas.className = 'pdf-page'
          wrap.appendChild(canvas)
          if (cancelled) break
          el.appendChild(wrap)
          await page.render({ canvas, viewport } as Parameters<typeof page.render>[0]).promise
          if (cancelled) break

          if (focusPage === n && focusQuote !== null) {
            focusHandled = true
            try {
              const textContent = await page.getTextContent()
              if (cancelled) break
              const container = document.createElement('div')
              container.className = 'textLayer'
              wrap.appendChild(container)
              await new pdfjs.TextLayer({ textContentSource: textContent, container, viewport: cssViewport }).render()
              if (cancelled) break
              const spans = Array.from(container.querySelectorAll('span'))
              const indices = matchSpans(spans.map((s) => s.textContent ?? ''), focusQuote)
              indices.forEach((i) => spans[i].classList.add('evidence-hl'))
              spans[indices[0]]?.scrollIntoView({ block: 'center' })
              onFocusResultRef.current?.(indices.length > 0)
            } catch (e) {
              console.error('pdf text layer', e)
              if (!cancelled) onFocusResultRef.current?.(false)
            }
          }
        }
        if (!cancelled && focusPage !== null && !focusHandled) onFocusResultRef.current?.(false)
      } catch (e) {
        if (!cancelled) {
          console.error('pdf viewer', e)
          setError(true)
          if (focusPage !== null) onFocusResultRef.current?.(false)
        }
      }
    })()
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [data, focusPage, focusQuote])

  return (
    <div className="pdf-viewer">
      {error && <p className="error">{t('paper.pdf_error', { message: errorText(t, 'unreadable_pdf') })}</p>}
      <div ref={pagesRef} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', alignItems: 'center' }} />
    </div>
  )
}
