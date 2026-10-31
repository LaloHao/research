/**
 * Icon-font glyphs for the reader view. An icon font draws its pictures from CSS (`::before { content: "\f005" }` on
 * an empty <i>, or a ligature such as Material Icons' «star»), and the reader view keeps none of the page's CSS: the
 * icon would vanish or turn into a word. So, where the page is read (the app's isolated world, the extension's
 * content script), each such glyph is drawn on a canvas with the page's own loaded font and kept on a copy of the
 * page as a small PNG in an attribute; each inline SVG gets the size it is shown at (usually set by CSS, too), and each
 * <canvas> (a chart drawn by scripts, empty in the HTML) a copy of what it shows. The page itself is never changed;
 * the reader view turns the attributes into inline images and sizes (see the app's capture/markup). No runtime imports: the extension bundles this, and the app runs `annotatedPageHtml` in
 * the page through its source text, so it must stay self-contained.
 */

/** The PNG of the glyph, as a data: URI. */
export const GLYPH_ATTRIBUTE = 'data-research-glyph'
/** Its box in CSS pixels: «width height descent». */
export const GLYPH_BOX_ATTRIBUTE = 'data-research-glyph-box'
/** The size an inline <svg> or a <canvas> is shown at on the page, in CSS pixels: «width height» («0 0» if hidden). */
export const SHOWN_SIZE_ATTRIBUTE = 'data-research-size'
/** What a <canvas> shows (a chart drawn by the page's scripts), as a PNG or JPEG data: URI. */
export const CANVAS_ATTRIBUTE = 'data-research-canvas'

/** At most this many glyphs (and this many characters of data: URI in total) are drawn per page. */
export const GLYPH_LIMITS = { count: 400, bytes: 64 * 1024, total: 3 * 1024 * 1024 } as const
/** At most this many canvases are copied per page, each and all together within these lengths of data: URI. */
export const CANVAS_LIMITS = { count: 20, bytes: 2 * 1024 * 1024, total: 4 * 1024 * 1024 } as const

/**
 * The page's HTML (`document.documentElement.outerHTML`) with every icon-font glyph drawn into `GLYPH_ATTRIBUTE`,
 * every canvas's picture in `CANVAS_ATTRIBUTE` and the shown size of both canvases and inline SVG in
 * `SHOWN_SIZE_ATTRIBUTE`, on a copy of each element. Self-contained (no outside names):
 * it runs as source text in the page.
 */
export function annotatedPageHtml(): string {
  const GLYPH = 'data-research-glyph'
  const BOX = 'data-research-glyph-box'
  const SIZE = 'data-research-size'
  const CANVAS = 'data-research-canvas'
  const MAX_COUNT = 400
  const MAX_BYTES = 64 * 1024
  const MAX_TOTAL = 3 * 1024 * 1024
  const MAX_CANVASES = 20
  const MAX_CANVAS = 2 * 1024 * 1024
  const MAX_CANVAS_TOTAL = 4 * 1024 * 1024
  const SCALE = 4
  const root = document.documentElement
  if (!root) return ''
  if (typeof getComputedStyle !== 'function') return root.outerHTML
  const live = Array.from(root.querySelectorAll('*'))
  const clone = root.cloneNode(true) as Element
  const copies = Array.from(clone.querySelectorAll('*'))
  if (copies.length !== live.length) return root.outerHTML
  const ICON_FAMILY = /icon|awesome|glyph|material|symbols|fa-|fontello|icomoon|feather|remix|codicon|phosphor|tabler|lucide|bootstrap-icons/i
  const LIGATURE_FAMILY = /material (icons|symbols)/i
  const SKIP = new Set(['head', 'meta', 'link', 'script', 'style', 'title', 'noscript', 'template', 'base', 'br', 'img', 'input', 'iframe'])
  const isPrivateUse = (cp: number): boolean => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000
  /** The text a computed `content` value draws: a quoted string (maybe with «/ alt text» after it), else nothing. */
  const contentText = (value: string): string => {
    const m = /^"((?:[^"\\]|\\.)*)"(?:\s*\/.*)?$/.exec(value.trim())
    return m ? m[1].replace(/\\(.)/g, '$1') : ''
  }
  const drawn = new Map<string, { src: string; box: string } | null>()
  let count = 0
  let total = 0
  let canvas: HTMLCanvasElement | null = null
  const draw = (text: string, style: CSSStyleDeclaration): { src: string; box: string } | null => {
    const size = parseFloat(style.fontSize) || 16
    const font = `${style.fontStyle} ${style.fontWeight} ${size * SCALE}px ${style.fontFamily}`
    const key = `${font}|${style.color}|${text}`
    if (drawn.has(key)) return drawn.get(key) ?? null
    let result: { src: string; box: string } | null = null
    try {
      if (count < MAX_COUNT && total < MAX_TOTAL && (!document.fonts || document.fonts.check(font, text))) {
        canvas ??= document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.font = font
          const m = ctx.measureText(text)
          const ascent = Math.ceil(m.fontBoundingBoxAscent || size * SCALE * 0.9)
          const descent = Math.ceil(m.fontBoundingBoxDescent || size * SCALE * 0.25)
          const width = Math.ceil(Math.max(m.width, (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)))
          if (width > 0 && width <= 4096 && ascent + descent <= 4096) {
            canvas.width = width
            canvas.height = ascent + descent
            ctx.font = font
            ctx.fillStyle = style.color || '#000'
            ctx.textBaseline = 'alphabetic'
            ctx.fillText(text, 0, ascent)
            const src = canvas.toDataURL('image/png')
            if (src.startsWith('data:image/png;base64,') && src.length <= MAX_BYTES) {
              count++
              total += src.length
              const css = (n: number): string => String(Math.round((n / SCALE) * 100) / 100)
              result = { src, box: `${css(width)} ${css(ascent + descent)} ${css(descent)}` }
            }
          }
        }
      }
    } catch {
      result = null
    }
    drawn.set(key, result)
    return result
  }
  const shown = (el: Element): string => {
    const box = el.getBoundingClientRect()
    return `${Math.round(box.width * 100) / 100} ${Math.round(box.height * 100) / 100}`
  }
  let canvases = 0
  let canvasTotal = 0
  /** A canvas's picture: PNG, or JPEG when the PNG is too large; null when it can't be read (a tainted canvas). */
  const picture = (el: HTMLCanvasElement): string | null => {
    try {
      if (el.width === 0 || el.height === 0) return null
      for (const [type, quality] of [['image/png', undefined], ['image/jpeg', 0.9]] as const) {
        const src = el.toDataURL(type, quality)
        if (src.startsWith(`data:${type};base64,`) && src.length <= MAX_CANVAS && canvasTotal + src.length <= MAX_CANVAS_TOTAL) return src
      }
    } catch {
      // Drawn from another site's image: the browser won't let it be read.
    }
    return null
  }
  for (let i = 0; i < live.length; i++) {
    const el = live[i]
    const tag = el.tagName.toLowerCase()
    if (SKIP.has(tag)) continue
    if (tag === 'svg' && !el.parentElement?.closest('svg')) {
      copies[i].setAttribute(SIZE, shown(el))
      continue
    }
    if (tag === 'canvas') {
      const src = canvases < MAX_CANVASES ? picture(el as HTMLCanvasElement) : null
      if (src) {
        canvases++
        canvasTotal += src.length
        copies[i].setAttribute(CANVAS, src)
        copies[i].setAttribute(SIZE, shown(el))
      }
      continue
    }
    if (el.childElementCount > 0) continue
    const own = (el.textContent ?? '').trim()
    let glyph: { src: string; box: string } | null = null
    if (own === '') {
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(el, pseudo)
        const text = contentText(style.content)
        const points = Array.from(text)
        if (points.length === 0 || points.length > 2) continue
        if (!points.some((c) => isPrivateUse(c.codePointAt(0) ?? 0)) && !ICON_FAMILY.test(style.fontFamily)) continue
        glyph = draw(text, style)
        if (glyph) break
      }
    } else if (/^[a-z0-9_]{1,40}$/.test(own)) {
      const style = getComputedStyle(el)
      if (LIGATURE_FAMILY.test(style.fontFamily)) glyph = draw(own, style)
    }
    if (glyph) {
      copies[i].setAttribute(GLYPH, glyph.src)
      copies[i].setAttribute(BOX, glyph.box)
    }
  }
  return clone.outerHTML
}

/** `annotatedPageHtml` as code to run in a page (the app's isolated world); its value is the HTML. */
export const ANNOTATED_PAGE_HTML = `(${annotatedPageHtml.toString()})()`
