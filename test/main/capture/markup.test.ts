import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { cleanMath, cleanSvg, glyphImage, mathVariantText, prepareMarkup, restoreMarkup } from '../../../src/main/capture/markup'
import { MATH_FONTS, prepareReaderHtml, READER_CSP, READER_CSS, sanitizeArticle, SYMBOL_FONTS } from '../../../src/main/capture/reader'
import { readArticle } from '../../../src/main/ingest/web'

const BASE = 'https://blog.acme.test/posts/math/'
const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function body(html: string): { document: Document; root: Element } {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
  return { document: document as unknown as Document, root: document.body as unknown as Element }
}

const LONG = '<p>' + 'The article explains the method in some detail, with enough words for a reader view to find it. '.repeat(6) + '</p>'

describe('cleanSvg', () => {
  it('keeps the drawing: allowlisted elements and attributes, fragment references, the root size and alignment', () => {
    const { root } = body(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 -750 1200 1000" width="3ex" height="2ex" style="vertical-align: -0.5ex; color: red; position: fixed"
      role="img" class="x"><defs><path id="g1" d="M0 0L10 10Z"/><linearGradient id="lg"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
      <g fill="url(#lg)" stroke="currentColor" transform="scale(1,-1)"><use xlink:href="#g1"/><text x="1" font-family="serif">x</text></g></svg>`)
    const svg = root.querySelector('svg')!
    expect(cleanSvg(svg)).toBe(true)
    const out = svg.outerHTML
    expect(out).toContain('<use href="#g1" />')
    expect(out).not.toContain('xlink:href')
    expect(out).toContain('fill="url(#lg)"')
    expect(out).toContain('style="vertical-align: -0.5ex"')
    expect(out).toMatch(/viewbox="0 -750 1200 1000"/i)
    expect(out).not.toMatch(/xmlns|class=|position|color: red/)
    expect(out).toContain('<text x="1" font-family="serif">x</text>')
  })

  it('drops scripts, foreignObject, styles, animations, images, links out of the document and event handlers', () => {
    const { root } = body(`<svg onload="alert(1)" viewBox="0 0 10 10"><script>alert(1)</script><style>*{fill:url(https://evil.test/x)}</style>
      <foreignObject><div onclick="x()">html</div></foreignObject><image href="https://evil.test/t.png"/><set attributeName="href" to="javascript:alert(1)"/>
      <animate attributeName="href" values="javascript:alert(1)"/><a href="javascript:alert(1)"><path d="M0 0" onclick="x()"/></a>
      <use href="https://evil.test/sprite.svg#a"/><use xlink:href="data:image/svg+xml,&lt;svg/&gt;#a"/><path d="M1 1" fill="url(https://evil.test/p)" mask="url(&quot;javascript:x&quot;)"/>
      <rect width="1" height="1" style="fill:red"/></svg>`)
    const svg = root.querySelector('svg')!
    expect(cleanSvg(svg)).toBe(true)
    const out = svg.outerHTML
    expect(out).not.toMatch(/script|style=|foreignobject|<image|<set|<animate|<a |onload|onclick|evil|javascript|data:/i)
    // The link's drawing stays, unwrapped; uses pointing outside the document lose their reference.
    expect(out).toContain('<path d="M0 0" />')
    expect(out.match(/<use \/>/g)).toHaveLength(2)
    expect(out).toContain('<path d="M1 1" />')
    expect(out).toContain('<rect width="1" height="1" />')
  })

  it('goes when it draws nothing (a sprite sheet) or was hidden on the page, and takes the size the page showed it at', () => {
    const sprite = body('<svg><defs><symbol id="i"><path d="M0 0"/></symbol></defs></svg>').root.querySelector('svg')!
    expect(cleanSvg(sprite)).toBe(false)
    const hidden = body('<svg data-research-size="0 0"><path d="M0 0"/></svg>').root.querySelector('svg')!
    expect(cleanSvg(hidden)).toBe(false)
    const icon = body('<svg data-research-size="28 28" viewBox="0 0 448 512"><use href="#i"/></svg>').root.querySelector('svg')!
    expect(cleanSvg(icon)).toBe(true)
    expect(icon.getAttribute('width')).toBe('28')
    expect(icon.getAttribute('height')).toBe('28')
    expect(icon.hasAttribute('data-research-size')).toBe(false)
    const sized = body('<svg width="3ex" data-research-size="40 20"><path d="M0 0"/></svg>').root.querySelector('svg')!
    cleanSvg(sized)
    expect(sized.getAttribute('width')).toBe('3ex')
    expect(sized.hasAttribute('height')).toBe(false)
  })
})

describe('cleanMath', () => {
  it('keeps presentation MathML and drops annotations, links, scripts, handlers and HTML around the text', () => {
    const { root } = body(`<math display="block" href="javascript:alert(1)" onclick="x()" class="k"><semantics><mrow><mi>x</mi><mo stretchy="false" form="prefix">(</mo>
      <mfrac linethickness="0"><mn>1</mn><msqrt><mi mathcolor="red">y</mi></msqrt></mfrac><mtext><span style="color:red">if</span> <b>ok</b></mtext><script>1</script>
      <maction actiontype="toggle"><mi>a</mi><mi>b</mi></maction></mrow><annotation encoding="application/x-tex">\\frac{1}{\\sqrt y}</annotation>
      <annotation-xml encoding="text/html"><img src="https://evil.test/x.png"></annotation-xml></semantics></math>`)
    const math = root.querySelector('math')!
    cleanMath(math)
    const out = math.outerHTML
    expect(out).toContain('<math display="block">')
    expect(out).toContain('<mo stretchy="false" form="prefix">(</mo>')
    expect(out).toContain('<mfrac linethickness="0">')
    expect(out).toContain('<mi mathcolor="red">y</mi>')
    expect(out).toContain('<mtext>if ok</mtext>')
    expect(out).toContain('<maction><mi>a</mi><mi>b</mi></maction>')
    expect(out).not.toMatch(/href|onclick|class|annotation|script|span|<b>|img|evil|\\frac/)
  })

  it('writes mathvariant letters as the Unicode letters that show them (MathML Core ignores the attribute)', () => {
    const { root } = body('<math><mi mathvariant="double-struck">R</mi><mi mathvariant="script">H</mi><mi mathvariant="bold">v</mi><mi mathvariant="fraktur">g</mi><mn mathvariant="bold">2</mn><mi mathvariant="normal">sin</mi></math>')
    const math = root.querySelector('math')!
    cleanMath(math)
    expect(math.textContent).toBe('ℝℋ𝐯𝔤𝟐sin')
    expect(math.querySelectorAll('mi[mathvariant="normal"]')).toHaveLength(5)
    expect(math.querySelector('mn')!.hasAttribute('mathvariant')).toBe(false)
    expect(mathVariantText('NZQCx1', 'double-struck')).toBe('ℕℤℚℂ𝕩𝟙')
    expect(mathVariantText('h', 'italic')).toBe('ℎ')
    expect(mathVariantText('αb', 'unknown')).toBe('αb')
  })
})

describe('prepareMarkup', () => {
  const prepare = (html: string): { document: Document; formulas: string[] } => {
    const { document } = body(html)
    const formulas = prepareMarkup(document)
    return { document, formulas }
  }

  it('reduces KaTeX to its MathML (a display one as a block) and sets every formula aside behind a placeholder', () => {
    const { document, formulas } = prepare(`<p>Inline <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">x</span></span></span> here.</p>
      <span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block"><mi>y</mi></math></span><span class="katex-html" aria-hidden="true">y</span></span></span>`)
    expect(formulas).toHaveLength(2)
    expect(formulas[0]).toBe('<math><semantics><mrow><mi>x</mi></mrow></semantics></math>')
    expect(formulas[1]).toBe('<math display="block"><mi>y</mi></math>')
    expect(document.querySelectorAll('.katex, .katex-html, math')).toHaveLength(0)
    expect(document.querySelectorAll('span[data-research-formula]')).toHaveLength(2)
    restoreMarkup(document, formulas)
    expect(document.body.innerHTML).toContain('<p>Inline <math><semantics><mrow><mi>x</mi></mrow></semantics></math> here.</p>')
    expect(document.body.innerHTML).toContain('<div><math display="block"><mi>y</mi></math></div>')
  })

  it("keeps MathJax's SVG without its hidden MathML copy, and uses the MathML of its CHTML output", () => {
    const { formulas } = prepare(`<mjx-container class="MathJax" jax="SVG" display="true"><svg style="vertical-align: -0.5ex" aria-hidden="true" viewBox="0 0 10 10"><use xlink:href="#MJX-G-x"/></svg><mjx-assistive-mml><math><mi>x</mi></math></mjx-assistive-mml></mjx-container>
      <mjx-container class="MathJax" jax="CHTML"><mjx-math><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D44E"></mjx-c></mjx-mi></mjx-math><mjx-assistive-mml><math><mi>a</mi></math></mjx-assistive-mml></mjx-container>
      <svg style="display:none" id="MJX-SVG-global-cache"><defs><path id="MJX-G-x" d="M0 0L5 5Z"/></defs></svg>`)
    expect(formulas).toHaveLength(3)
    // The glyph from the shared cache is copied into the formula; the hidden cache itself is set aside too.
    expect(formulas[0]).toContain('<defs><path id="MJX-G-x" d="M0 0L5 5Z" /></defs>')
    expect(formulas[0]).toContain('display: block; margin: 0.6em auto')
    expect(formulas[0]).not.toContain('aria-hidden')
    expect(formulas[0]).not.toContain('<math')
    expect(formulas[1]).toBe('<math><mi>a</mi></math>')
  })

  it("uses Wikipedia's MathML instead of its hidden copy and its fallback picture, and turns a copied canvas into its picture", () => {
    const { document, formulas } = prepare(`<p>Then <span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display: none;"><math><mi>z</mi></math></span><img src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc" class="mwe-math-fallback-image-inline" aria-hidden="true"></span>.</p>
      <canvas width="600" height="200" data-research-canvas="${PNG_URI}" data-research-size="300 100"></canvas><canvas data-research-canvas="data:text/html;base64,PGI+"></canvas>`)
    expect(formulas).toEqual(['<math><mi>z</mi></math>'])
    expect(document.querySelector('img.mwe-math-fallback-image-inline')).toBeNull()
    const img = document.querySelector('img')!
    expect(img.getAttribute('src')).toBe(PNG_URI)
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['300', '100'])
    // A canvas whose copy is not a PNG or JPEG stays a canvas (the sanitizer drops it).
    expect(document.querySelectorAll('canvas')).toHaveLength(1)
  })
})

describe('glyphImage', () => {
  const el = body('<i></i>').root.querySelector('i')!
  it('turns a drawn icon glyph into an inline image on the baseline', () => {
    const img = glyphImage(el, PNG_URI, '18.5 20 3.25')!
    expect(img.tagName.toLowerCase()).toBe('img')
    expect(Object.fromEntries(Array.from(img.attributes).map((a) => [a.name, a.value]))).toEqual({
      src: PNG_URI,
      alt: '',
      class: 'glyph',
      style: 'width: 18.5px; height: 20px; vertical-align: -3.25px'
    })
  })

  it('refuses anything but a PNG data: URI with a sane box', () => {
    expect(glyphImage(el, 'https://evil.test/x.png', '10 10 1')).toBeNull()
    expect(glyphImage(el, 'data:image/svg+xml;base64,PHN2Zz4=', '10 10 1')).toBeNull()
    expect(glyphImage(el, `${PNG_URI}"><script>`, '10 10 1')).toBeNull()
    expect(glyphImage(el, PNG_URI, '10 10')).toBeNull()
    expect(glyphImage(el, PNG_URI, '9999 10 1')).toBeNull()
    expect(glyphImage(el, `data:image/png;base64,${'A'.repeat(70000)}`, '10 10 1')).toBeNull()
  })
})

describe('the reader view of formulas, SVG and icons', () => {
  it('keeps them through Readability even in blocks with no other text, sanitized', () => {
    const page = `<html><head><title>Gaussian integrals</title></head><body><article><h1>Gaussian integrals</h1>${LONG}
      <div class="card"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block"><msubsup><mo>∫</mo><mn>0</mn><mi>∞</mi></msubsup><annotation encoding="application/x-tex">\\int</annotation></math></span><span class="katex-html" aria-hidden="true">∫</span></span></span></div>
      <div class="card"><mjx-container jax="SVG" display="true"><svg viewBox="0 0 10 10" aria-hidden="true" onload="x()"><path d="M0 0L9 9Z"/></svg></mjx-container></div>
      <p>Stars: <i class="fa fa-star" data-research-glyph="${PNG_URI}" data-research-glyph-box="16 16 2"></i> and <i class="fa fa-moon" data-research-glyph="javascript:alert(1)" data-research-glyph-box="16 16 2">moon</i>.</p>${LONG}</article></body></html>`
    const prepared = prepareReaderHtml(page)
    const article = readArticle(prepared.html, BASE)!
    expect(article.content).not.toContain('<math')
    const html = sanitizeArticle(article.content, BASE, prepared.formulas)
    expect(html).toContain('<math display="block"><msubsup><mo>∫</mo><mn>0</mn><mi>∞</mi></msubsup></math>')
    expect(html).toContain('<svg style="display: block; margin: 0.6em auto" viewBox="0 0 10 10"><path d="M0 0L9 9Z" /></svg>')
    expect(html).toMatch(/Stars: <img [^>]*class="glyph"/)
    expect(html).toContain(`src="${PNG_URI}"`)
    // A glyph whose picture is not valid stays the element it was.
    expect(html).toContain(' and <i>moon</i>.')
    expect(html).not.toMatch(/onload|annotation|data-research|placeholder|set aside/)
  })

  it('sets fonts with wide coverage, a math font for MathML, and still loads nothing but its own style and data: images', () => {
    expect(READER_CSS).toContain(SYMBOL_FONTS)
    expect(READER_CSS).toContain(`math { font-family: ${MATH_FONTS}; }`)
    expect(SYMBOL_FONTS).toMatch(/"Noto Sans Math".*"DejaVu Sans".*"Noto Color Emoji"/)
    expect(MATH_FONTS).toMatch(/^"Latin Modern Math".*math$/)
    expect(READER_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'")
  })
})
