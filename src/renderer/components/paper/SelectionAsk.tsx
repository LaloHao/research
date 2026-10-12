import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** A selection to ask about: the text as selected and its page (null for text without pages). */
export interface SelectionAskTarget {
  quote: string
  page: number | null
}

type Shown = SelectionAskTarget & { top: number; left: number }

/** The `data-page` of the page element around a node, or null outside any page. */
function pageOf(node: Node): number | null {
  const element = node instanceof Element ? node : node.parentElement
  const page = Number(element?.closest('[data-page]')?.getAttribute('data-page'))
  return Number.isInteger(page) && page > 0 ? page : null
}

/**
 * «Preguntar a Claude» under a text selection that starts inside `containerRef` (which must be `position: relative`).
 * The page is the `data-page` of the page element where the selection starts in reading order (whichever way it was
 * dragged). Rendered by React as a sibling of the selected content; it never touches that content.
 */
export function SelectionAsk({
  containerRef,
  onAsk
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onAsk: (target: SelectionAskTarget) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (): void => {
      const selection = window.getSelection()
      const text = selection?.toString() ?? ''
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      if (!range || !text.trim() || !container.contains(range.startContainer)) {
        setShown(null)
        return
      }
      const rect = range.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      setShown({
        quote: text,
        page: pageOf(range.startContainer),
        top: rect.bottom - box.top + container.scrollTop + 4,
        left: Math.max(0, rect.left - box.left + container.scrollLeft)
      })
    }
    const clear = (): void => {
      if (!window.getSelection()?.toString().trim()) setShown(null)
    }
    // On the document, so a drag that ends outside the container still offers the button.
    document.addEventListener('mouseup', update)
    container.addEventListener('keyup', update)
    document.addEventListener('selectionchange', clear)
    return () => {
      document.removeEventListener('mouseup', update)
      container.removeEventListener('keyup', update)
      document.removeEventListener('selectionchange', clear)
    }
  }, [containerRef])

  if (!shown) return null
  return (
    <button
      type="button"
      className="selection-ask small primary"
      style={{ top: shown.top, left: shown.left }}
      // Keeps the selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onAsk({ quote: shown.quote, page: shown.page })
        setShown(null)
      }}
    >
      {t('chat.ask_claude')}
    </button>
  )
}
