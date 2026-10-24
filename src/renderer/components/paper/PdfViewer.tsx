import 'pdfjs-dist/web/pdf_viewer.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'
import { matchSpans } from '../../lib/highlight'
import { pdfjs } from './pdfjs'
import { SelectionAsk, type SelectionAskTarget } from './SelectionAsk'

export type PdfFocus = { page: number; quote: string }

/** How far outside the visible area a page gets its selectable text layer ahead of being scrolled to. */
const TEXT_LAYER_MARGIN = '1200px 0px'

/** The nearest ancestor that scrolls (the root a look-ahead margin must apply to), or null for the viewport. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * Renders every page to a canvas, fitted to the panel width. The page named by `focus` also gets
 * a text layer with the matching spans highlighted and scrolled into view; `onFocusResult` reports
 * whether the quote was found there (the caller falls back to the plain-text passage when it was
 * not, or when there is no `focus`).
 *
 * With `onAsk`, every page also gets a selectable text layer (built when the page comes near the visible area, so a
 * long PDF does not lay out the text of every page up front) and each page element carries its number in `data-page`;
 * a selection then offers «Preguntar a Claude».
 */
export function PdfViewer({
  data,
  focus,
  onFocusResult,
  onAsk
}: {
  data: Uint8Array
  focus?: PdfFocus | null
  onFocusResult?: (found: boolean) => void
  onAsk?: (target: SelectionAskTarget) => boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const viewerRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const selectable = Boolean(onAsk)
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
    type PageProxy = Awaited<ReturnType<Awaited<typeof task.promise>['getPage']>>
    type Viewport = ReturnType<PageProxy['getViewport']>
    /** Draws a page's text layer (spans over the canvas, aligned to it); null when the viewer was torn down meanwhile. */
    const addTextLayer = async (page: PageProxy, wrap: HTMLElement, viewport: Viewport): Promise<HTMLElement | null> => {
      const textContent = await page.getTextContent()
      if (cancelled) return null
      const container = document.createElement('div')
      container.className = 'textLayer'
      wrap.appendChild(container)
      await new pdfjs.TextLayer({ textContentSource: textContent, container, viewport }).render()
      return cancelled ? null : container
    }
    // Pages waiting for their selectable text layer until they come near the visible area.
    const waiting = new Map<Element, () => void>()
    const observer = selectable
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              observer?.unobserve(entry.target)
              const build = waiting.get(entry.target)
              waiting.delete(entry.target)
              build?.()
            }
          },
          // Rooted at the scrolling panel: against the viewport, the panel's clipping would cancel the margin.
          { root: scrollParent(el), rootMargin: TEXT_LAYER_MARGIN }
        )
      : null
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
          wrap.dataset.page = String(n)
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
            // The focused page gets its text layer right away, with the quote highlighted.
            focusHandled = true
            if (!focusQuote.trim()) {
              // Only a page to show (an editor's citation without a quote): nothing to look for.
              wrap.scrollIntoView({ block: 'start' })
              onFocusResultRef.current?.(true)
              continue
            }
            try {
              const container = await addTextLayer(page, wrap, cssViewport)
              if (!container) break
              const spans = Array.from(container.querySelectorAll('span'))
              const indices = matchSpans(spans.map((s) => s.textContent ?? ''), focusQuote)
              indices.forEach((i) => spans[i].classList.add('evidence-hl'))
              spans[indices[0]]?.scrollIntoView({ block: 'center' })
              onFocusResultRef.current?.(indices.length > 0)
            } catch (e) {
              console.error('pdf text layer', e)
              if (!cancelled) onFocusResultRef.current?.(false)
            }
          } else if (observer) {
            // Selectable text for «Preguntar a Claude», built once the page is near the visible area.
            waiting.set(wrap, () => {
              addTextLayer(page, wrap, cssViewport).catch((e: unknown) => {
                if (!cancelled) console.error('pdf text layer', e)
              })
            })
            observer.observe(wrap)
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
      observer?.disconnect()
      waiting.clear()
      void task.destroy()
    }
  }, [data, focusPage, focusQuote, selectable])

  return (
    <div className="pdf-viewer" ref={viewerRef}>
      {error && <p className="error">{t('paper.pdf_error', { message: errorText(t, 'unreadable_pdf') })}</p>}
      <div ref={pagesRef} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', alignItems: 'center' }} />
      {onAsk && <SelectionAsk containerRef={viewerRef} onAsk={onAsk} />}
    </div>
  )
}
