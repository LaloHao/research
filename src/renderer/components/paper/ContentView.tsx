import { useEffect, useMemo, useRef, useState } from 'react'
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

/** A link, unless its href was stripped by `urlTransform` (a disallowed scheme), in which case just its text. */
function ContentLink({ href, children }: { href?: string; children?: React.ReactNode }): React.JSX.Element {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  )
}

/**
 * Images are never loaded (CSP blocks remote images, and this is untrusted web content anyway);
 * shown instead as a small chip linking to the image, labelled with its alt text or, lacking
 * that, its URL's host.
 */
function ContentImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const label = alt?.trim() || (src ? hostOf(src) : t('paper.content.image_unavailable'))
  return src ? (
    <a className="content-image-chip" href={src} target="_blank" rel="noreferrer">
      {t('paper.content.image', { label })}
    </a>
  ) : (
    <span className="content-image-chip">{t('paper.content.image', { label })}</span>
  )
}

// Declared once at module scope, not inline in ContentView, so react-markdown's `components`
// prop keeps the same identity across renders: a new object there would make react-markdown treat
// `a`/`img` as different component types and remount every link and image on every render (e.g.
// the detail view's `library-changed`/`jobs-changed` refresh), tearing down the very DOM nodes any
// live CSS highlight ranges point into.
const components = { a: ContentLink, img: ContentImage }

const HIGHLIGHT_NAME = 'evidence'

export interface ContentFocus {
  quote: string
  // Bumped on every evidence click, including a repeat click on the same quote, so the
  // scroll-into-view still happens even though `quote` itself didn't change.
  seq: number
}

/**
 * Renders web-page content (Markdown produced by turndown) as a readable document, with GFM
 * (tables, strikethrough, etc.), no raw HTML, links restricted to http(s)/mailto, and remote
 * images shown as a link chip instead of being loaded.
 *
 * When `focus` is set, its quote is located among the rendered text nodes — tolerant of case,
 * whitespace and equivalent Unicode forms (composed vs. decomposed accents), and of hyphenated
 * line breaks, the same as the PDF and summary evidence links; see {@link findQuoteRanges} — and
 * highlighted via the CSS Custom Highlight API (`::highlight(evidence)` in styles.css), with the
 * first match scrolled into view. This never mutates the rendered DOM (no splitting or wrapping
 * text nodes), so it can't conflict with React's own reconciliation of that same tree. A quote
 * that cannot be found shows a small notice instead.
 */
export function ContentView({ content, focus }: { content: string; focus: ContentFocus | null }): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [notFound, setNotFound] = useState(false)

  // Memoized on `content` alone: a `focus`-only change (a different quote, or a repeat click on
  // the same one) must not recreate this element, or the DOM nodes the highlight effect below
  // just walked and pointed ranges into would be torn down and remounted from scratch.
  const markdown = useMemo(
    () => (
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {content}
      </Markdown>
    ),
    [content]
  )

  useEffect(() => {
    const container = containerRef.current
    const quote = focus?.quote ?? null
    if (container && quote) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)

      const quoteRanges = findQuoteRanges(textNodes.map((n) => n.textContent ?? ''), quote)
      setNotFound(quoteRanges.length === 0)
      if (quoteRanges.length > 0) {
        const ranges = quoteRanges.map(({ nodeIndex, start, end }) => {
          const range = new Range()
          range.setStart(textNodes[nodeIndex], start)
          range.setEnd(textNodes[nodeIndex], end)
          return range
        })
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
        ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' })
      } else {
        CSS.highlights.delete(HIGHLIGHT_NAME)
      }
    } else {
      setNotFound(false)
      CSS.highlights.delete(HIGHLIGHT_NAME)
    }
    return () => {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    }
  }, [content, focus])

  return (
    <div className="content-view-wrap">
      {notFound && <p className="content-notice muted">{t('paper.content.quote_not_found')}</p>}
      <div className="content-view" ref={containerRef}>
        {markdown}
      </div>
    </div>
  )
}
