import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown, { type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { findQuoteRanges } from '../../lib/textHighlight'

const ALLOWED_LINK_SCHEME = /^(https?:|mailto:)/i
const ALLOWED_IMAGE_SCHEME = /^https?:/i

/** Links may be http(s) or mailto; images (never loaded, shown as a chip instead) only http(s). */
const urlTransform: UrlTransform = (url, _key, node) => {
  const allowed = node.tagName === 'img' ? ALLOWED_IMAGE_SCHEME.test(url) : ALLOWED_LINK_SCHEME.test(url)
  return allowed ? url : ''
}

/** The host of a URL, or the URL itself when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A `<mark class="evidence-hl">`'s children are moved back to its parent, then it is removed. */
function clearMarks(container: HTMLElement): void {
  container.querySelectorAll('mark.evidence-hl').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

/** Wraps `node[start:end]` in a new `<mark class="evidence-hl">`, splitting the text node as needed. */
function wrapRange(node: Text, start: number, end: number): HTMLElement {
  let target = node
  if (start > 0) target = target.splitText(start)
  if (end - start < target.length) target.splitText(end - start)
  const mark = document.createElement('mark')
  mark.className = 'evidence-hl'
  target.replaceWith(mark)
  mark.appendChild(target)
  return mark
}

/**
 * Renders web-page content (Markdown produced by turndown) as a readable document, with GFM
 * (tables, strikethrough, etc.), no raw HTML, links restricted to http(s)/mailto, and remote
 * images shown as a link chip instead of being loaded (blocked by CSP anyway).
 *
 * When `quote` is set, it is located among the rendered text nodes (tolerant of case, diacritic
 * and whitespace differences, same as the PDF and summary evidence links) and highlighted; the
 * first match is scrolled into view. A quote that cannot be found shows a small notice instead.
 */
export function ContentView({ content, quote }: { content: string; quote: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    clearMarks(container)
    if (!quote) {
      setNotFound(false)
      return
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)

    const ranges = findQuoteRanges(textNodes.map((n) => n.textContent ?? ''), quote)
    setNotFound(ranges.length === 0)
    let first: HTMLElement | null = null
    for (const range of ranges) {
      const mark = wrapRange(textNodes[range.nodeIndex], range.start, range.end)
      first ??= mark
    }
    first?.scrollIntoView({ block: 'center' })
  }, [content, quote])

  return (
    <div className="content-view-wrap">
      <div className="content-view" ref={containerRef}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={urlTransform}
          components={{
            a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
              href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ) : (
                <>{children}</>
              ),
            img: ({ src, alt }: { src?: string; alt?: string }) => {
              const label = alt?.trim() || (src ? hostOf(src) : t('paper.content.image_unavailable'))
              return src ? (
                <a className="content-image-chip" href={src} target="_blank" rel="noreferrer">
                  {t('paper.content.image', { label })}
                </a>
              ) : (
                <span className="content-image-chip">{t('paper.content.image', { label })}</span>
              )
            }
          }}
        >
          {content}
        </Markdown>
      </div>
      {notFound && <p className="content-notice muted">{t('paper.content.quote_not_found')}</p>}
    </div>
  )
}
