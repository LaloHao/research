import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** A selection to ask about: the text as selected and its page (null for text without pages). */
export interface SelectionAskTarget {
  quote: string
  page: number | null
}

/** `refused`: the selection cannot be quoted, so a hint replaces the button. */
type Shown = SelectionAskTarget & { top: number; left: number; refused: boolean }

/** The page number in an element's `data-page`, or null. */
function pageNumber(element: Element | null | undefined): number | null {
  const page = Number(element?.getAttribute('data-page'))
  return Number.isInteger(page) && page > 0 ? page : null
}

/** The `data-page` of the page element around a node, or null outside any page. */
function pageOf(node: Node | null | undefined): number | null {
  const element = node instanceof Element ? node : node?.parentElement
  return pageNumber(element?.closest('[data-page]'))
}

/**
 * The page where a selection starts: the page around its start or, when it starts between pages (a gap, the padding),
 * the first page it reaches.
 */
function startPage(range: Range, container: HTMLElement): number | null {
  const around = pageOf(range.startContainer)
  if (around !== null) return around
  if (range.startContainer instanceof Element) {
    const next = pageOf(range.startContainer.childNodes[range.startOffset])
    if (next !== null) return next
  }
  for (const page of container.querySelectorAll('[data-page]')) {
    if (range.intersectsNode(page)) return pageNumber(page)
  }
  return null
}

/**
 * «Preguntar a Claude» under a text selection that starts inside `containerRef` (which must be `position: relative`).
 * The page is the `data-page` of the page element where the selection starts in reading order (whichever way it was
 * dragged). `onAsk` answers false when the selection cannot be quoted; a short hint then replaces the button. Escape
 * dismisses it. Rendered by React as a sibling of the selected content; it never touches that content.
 */
export function SelectionAsk({
  containerRef,
  onAsk
}: {
  containerRef: React.RefObject<HTMLElement | null>
  onAsk: (target: SelectionAskTarget) => boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (e: Event): void => {
      // Escape dismisses the button; the selection itself stays.
      if (e instanceof KeyboardEvent && e.key === 'Escape') return
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
        page: startPage(range, container),
        top: rect.bottom - box.top + container.scrollTop + 4,
        left: Math.max(0, rect.left - box.left + container.scrollLeft),
        refused: false
      })
    }
    const dismiss = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShown(null)
    }
    const clear = (): void => {
      if (!window.getSelection()?.toString().trim()) setShown(null)
    }
    // On the document, so a drag that ends outside the container still offers the button.
    document.addEventListener('mouseup', update)
    container.addEventListener('keyup', update)
    document.addEventListener('selectionchange', clear)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('mouseup', update)
      container.removeEventListener('keyup', update)
      document.removeEventListener('selectionchange', clear)
    }
  }, [containerRef])

  if (!shown) return null
  if (shown.refused) {
    return (
      <p className="selection-ask selection-ask-hint small" role="status" style={{ top: shown.top, left: shown.left }}>
        {t('chat.ask_claude_unquotable')}
      </p>
    )
  }
  return (
    <button
      type="button"
      className="selection-ask small primary"
      style={{ top: shown.top, left: shown.left }}
      // Keeps the selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (onAsk({ quote: shown.quote, page: shown.page })) setShown(null)
        else setShown({ ...shown, refused: true })
      }}
    >
      {t('chat.ask_claude')}
    </button>
  )
}
