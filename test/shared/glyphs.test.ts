import { afterEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { ANNOTATED_PAGE_HTML, CANVAS_ATTRIBUTE, GLYPH_ATTRIBUTE, GLYPH_BOX_ATTRIBUTE, SHOWN_SIZE_ATTRIBUTE } from '../../src/shared/pageCapture/glyphs'

const scope = globalThis as unknown as Record<string, unknown>

/** What a computed style reads in the fake page: the `::before` content and font of each icon, the font of the rest. */
type Styles = Record<string, { content?: string; fontFamily: string; color?: string }>

const PNG = 'data:image/png;base64,iVBORw0KGgo='

/**
 * A page in linkedom with what the browser would add: computed styles (from `styles`, by class), element boxes, a
 * canvas that records what it draws, the page's fonts all loaded. The annotator runs as the app runs it: its source.
 */
function runInPage(
  html: string,
  styles: Styles,
  canvases: Record<string, () => string> = {},
  glyphUri?: () => string
): { html: string; drawn: string[]; page: string } {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
  const drawn: string[] = []
  const styleOf = (el: Element, pseudo?: string): Record<string, string> => {
    const entry = styles[el.getAttribute('class') ?? ''] ?? { fontFamily: 'serif' }
    return {
      content: pseudo ? (entry.content ?? 'none') : 'normal',
      fontFamily: entry.fontFamily,
      fontSize: '16px',
      fontStyle: 'normal',
      fontWeight: '900',
      color: entry.color ?? 'rgb(0, 0, 0)'
    }
  }
  // What the browser adds, on the prototypes (linkedom clones elements by creating them anew).
  let base = Object.getPrototypeOf(document.body) as object
  while (!Object.hasOwn(base, 'getAttribute')) base = Object.getPrototypeOf(base) as object
  Object.defineProperty(base, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      return this.getAttribute('hidden') !== null ? { width: 0, height: 0 } : { width: 28.123, height: 14 }
    }
  })
  // The page's canvases (by id) and the one the annotator draws glyphs on (no id).
  const ctx = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    measureText: (text: string) => ({ width: 64 * Array.from(text).length, fontBoundingBoxAscent: 56, fontBoundingBoxDescent: 14 }),
    fillText: (text: string) => drawn.push(`${ctx.font}|${ctx.fillStyle}|${text}`)
  }
  const canvasProto = Object.getPrototypeOf(document.createElement('canvas')) as object
  Object.defineProperty(canvasProto, 'getContext', { configurable: true, value: () => ctx })
  Object.defineProperty(canvasProto, 'toDataURL', {
    configurable: true,
    value(this: Element) {
      const id = this.getAttribute('id')
      if (id === null) return (glyphUri ?? (() => `${PNG}${drawn.length}`))()
      return (canvases[id] ?? (() => PNG))()
    }
  })
  ;(document as unknown as { fonts: { check: () => boolean } }).fonts = { check: () => true }
  scope.document = document
  scope.getComputedStyle = styleOf
  const out = (0, eval)(ANNOTATED_PAGE_HTML) as string
  return { html: out, drawn, page: document.documentElement.outerHTML }
}

afterEach(() => {
  delete scope.document
  delete scope.getComputedStyle
})

const attr = (html: string, selector: string, name: string): string | null => {
  const { document } = parseHTML(html)
  return document.querySelector(selector)?.getAttribute(name) ?? null
}

describe('annotatedPageHtml', () => {
  const FA = { content: '"\uf005" / ""', fontFamily: '"Font Awesome 7 Free"', color: 'rgb(230, 57, 70)' }

  it('draws icon-font glyphs (private-use characters, alt text after «/») with the page font and colour, on a copy', () => {
    const { html, drawn, page } = runInPage('<p>Rated <i class="star"></i> <i class="star"></i> and <span class="arrow"></span>.</p>', {
      star: FA,
      arrow: { content: '"→"', fontFamily: '"Noto Serif"' }
    })
    expect(drawn).toEqual(['normal 900 64px "Font Awesome 7 Free"|rgb(230, 57, 70)|\uf005'])
    expect(attr(html, 'i.star', GLYPH_ATTRIBUTE)).toBe(`${PNG}1`)
    expect(attr(html, 'i.star', GLYPH_BOX_ATTRIBUTE)).toBe('16 17.5 3.5')
    // Both stars, drawn once; an ordinary character from CSS is left alone; the page itself is untouched.
    expect(html.match(new RegExp(GLYPH_ATTRIBUTE + '=', 'g'))).toHaveLength(2)
    expect(attr(html, 'span.arrow', GLYPH_ATTRIBUTE)).toBeNull()
    expect(page).not.toContain('data-research')
  })

  it("draws a ligature icon font's word (Material Icons) and an icon font's non-private character", () => {
    const { html, drawn } = runInPage('<p><span class="material">home</span> <i class="bi"></i> <span class="text">home</span></p>', {
      material: { fontFamily: '"Material Icons"' },
      bi: { content: '"★"', fontFamily: 'bootstrap-icons' },
      text: { fontFamily: 'serif' }
    })
    expect(drawn.map((d) => d.split('|')[2])).toEqual(['home', '★'])
    expect(attr(html, 'span.material', GLYPH_ATTRIBUTE)).not.toBeNull()
    expect(attr(html, 'span.text', GLYPH_ATTRIBUTE)).toBeNull()
  })

  it('records the size SVG and canvases are shown at, and copies what a canvas shows unless it is tainted', () => {
    const { html } = runInPage('<svg class="icon"><svg><path d="M0 0"></path></svg></svg><svg hidden><path d="M0 0"></path></svg><canvas id="chart" width="300" height="100"></canvas><canvas id="tainted" width="300" height="100"></canvas>', {}, {
      tainted: () => {
        throw new Error('SecurityError')
      }
    })
    expect(attr(html, 'svg.icon', SHOWN_SIZE_ATTRIBUTE)).toBe('28.12 14')
    // The outermost SVGs and the canvas copied: not the nested SVG, nor the tainted canvas.
    expect(html.match(new RegExp(SHOWN_SIZE_ATTRIBUTE + '=', 'g'))).toHaveLength(3)
    expect(attr(html, 'svg[hidden]', SHOWN_SIZE_ATTRIBUTE)).toBe('0 0')
    expect(attr(html, '#chart', CANVAS_ATTRIBUTE)).toBe(PNG)
    expect(attr(html, '#tainted', CANVAS_ATTRIBUTE)).toBeNull()
  })

  it('keeps to its limits: a glyph whose picture is too large is left out', () => {
    const { html } = runInPage('<i class="star"></i>', { star: FA }, {}, () => `${PNG}${'A'.repeat(70 * 1024)}`)
    expect(html).not.toContain(GLYPH_ATTRIBUTE)
  })
})
