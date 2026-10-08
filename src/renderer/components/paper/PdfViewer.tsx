import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../../lib/errorText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Renders every page to a canvas, fitted to the panel width. */
export function PdfViewer({ data }: { data: Uint8Array }): React.JSX.Element {
  const { t } = useTranslation()
  const pagesRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const el = pagesRef.current
    if (!el) return
    el.replaceChildren()
    setError(false)
    let cancelled = false
    const task = pdfjs.getDocument({ data: data.slice() })
    void (async () => {
      try {
        const doc = await task.promise
        const ratio = window.devicePixelRatio || 1
        const width = Math.max(el.clientWidth, 320)
        for (let n = 1; n <= doc.numPages && !cancelled; n++) {
          const page = await doc.getPage(n)
          const scale = width / page.getViewport({ scale: 1 }).width
          const viewport = page.getViewport({ scale: scale * ratio })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
          canvas.className = 'pdf-page'
          el.appendChild(canvas)
          await page.render({ canvas, viewport } as Parameters<typeof page.render>[0]).promise
        }
      } catch (e) {
        if (!cancelled) {
          console.error('pdf viewer', e)
          setError(true)
        }
      }
    })()
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [data])

  return (
    <div className="pdf-viewer">
      {error && <p className="error">{t('paper.pdf_error', { message: errorText(t, 'unreadable_pdf') })}</p>}
      <div ref={pagesRef} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', alignItems: 'center' }} />
    </div>
  )
}
