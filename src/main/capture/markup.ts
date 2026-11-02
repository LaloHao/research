/**
 * Formulas, inline SVG and icon glyphs in the reader view. A page draws math in one of a few ways: MathML (Chromium
 * renders MathML Core), KaTeX (HTML positioned by its CSS and web fonts, with a hidden MathML copy), MathJax (SVG with
 * glyph paths, or CHTML with its fonts, each with a hidden MathML copy) or Wikipedia's (hidden MathML and an SVG
 * picture). The reader view keeps none of the page's CSS or fonts, so before the article is extracted each formula is
 * reduced to what renders without them: its MathML, or MathJax's SVG. Inline SVG and MathML then go through strict
 * allowlists (no scripts, no foreignObject, no styles, no links to anything but a fragment of the same document).
 */

import { CANVAS_ATTRIBUTE, SHOWN_SIZE_ATTRIBUTE } from '../../shared/pageCapture/glyphs'

type El = Element

const SVG_NS_ATTRIBUTES = /^xmlns(:|$)/

/** SVG elements kept; any other one is removed with its content (`a` is unwrapped). */
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'title', 'desc', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker'
])

const SVG_ATTRIBUTES = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points',
  'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'clip-path', 'clip-rule',
  'mask', 'marker-start', 'marker-mid', 'marker-end', 'preserveaspectratio', 'font-size', 'font-family', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'dx', 'dy', 'rotate',
  'textlength', 'lengthadjust', 'letter-spacing', 'word-spacing', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'offset', 'stop-color', 'stop-opacity', 'patternunits', 'patterncontentunits', 'patterntransform', 'maskunits',
  'maskcontentunits', 'clippathunits', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
  'visibility', 'color', 'overflow', 'vector-effect', 'shape-rendering', 'paint-order', 'role', 'aria-label', 'id'
])

/** MathML elements kept (presentation MathML, as Chromium's MathML Core renders it); unknown ones are unwrapped. */
const MATH_ELEMENTS = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msub', 'msup', 'msubsup', 'munder', 'mover',
  'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mpadded', 'mphantom',
  'menclose', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'merror', 'mfenced', 'maction'
])

const MATH_ATTRIBUTES = new Set([
  'display', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'dir', 'fence',
  'separator', 'stretchy', 'symmetric', 'largeop', 'movablelimits', 'accent', 'accentunder', 'lspace', 'rspace', 'minsize',
  'maxsize', 'form', 'linethickness', 'columnalign', 'rowalign', 'columnspan', 'rowspan', 'columnlines', 'rowlines',
  'columnspacing', 'rowspacing', 'frame', 'framespacing', 'equalrows', 'equalcolumns', 'width', 'height', 'depth',
  'voffset', 'notation', 'open', 'close', 'separators', 'align', 'selection'
])

/** Removed with everything inside wherever they appear in SVG or MathML. */
const NEVER = new Set(['script', 'style', 'foreignobject', 'iframe', 'object', 'embed', 'annotation', 'annotation-xml', 'image', 'feimage', 'animate', 'animatemotion', 'animatetransform', 'set'])

const FRAGMENT = /^#[A-Za-z_][\w.:-]{0,200}$/
const ID = /^[A-Za-z_][\w.:-]{0,200}$/
const URL_REF = /^url\(\s*(['"]?)#[A-Za-z_][\w.:-]{0,200}\1\s*\)$/
/** A plain attribute value: no markup, no escapes, no url() but a fragment one, no script-ish schemes. */
const SAFE_VALUE = /^[^<>\\]{0,20000}$/
const MATH_VALUE = /^[\w\s.#%+,-]{0,100}$/
const LENGTH = /^-?\d{1,5}(\.\d{1,4})?(ex|em|px|pt|rem|%)?$/
/** The inline style properties an <svg> may keep (MathJax aligns its formulas on the baseline with them). */
const SVG_STYLE = new Set(['vertical-align', 'width', 'height', 'min-width', 'max-width'])
/** And the ones a display formula gets here, with these exact values. */
const SVG_DISPLAY_STYLE: Record<string, string> = { display: 'block', margin: '0.6em auto' }

function unwrap(el: El): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  el.remove()
}

function svgValueOk(name: string, value: string): boolean {
  if (!SAFE_VALUE.test(value) || /javascript:|data:|expression\(|@import/i.test(value)) return false
  if (/url\(/i.test(value)) return URL_REF.test(value.trim())
  if (name === 'id') return ID.test(value)
  return true
}

function svgStyle(value: string): string {
  const kept: string[] = []
  for (const part of value.split(';')) {
    const [prop, ...rest] = part.split(':')
    const name = prop?.trim().toLowerCase() ?? ''
    const v = rest.join(':').trim()
    if ((SVG_STYLE.has(name) && LENGTH.test(v)) || SVG_DISPLAY_STYLE[name] === v) kept.push(`${name}: ${v}`)
  }
  return kept.join('; ')
}

function cleanSvgAttributes(el: El, root: boolean): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const value = attr.value
    if (name === 'href' || name === 'xlink:href') {
      el.removeAttribute(attr.name)
      // Only <use> and paint servers point somewhere, and only into this document.
      if (FRAGMENT.test(value.trim()) && /^(use|lineargradient|radialgradient|pattern)$/.test(el.tagName.toLowerCase())) el.setAttribute('href', value.trim())
      continue
    }
    if (root && name === 'style') {
      const style = svgStyle(value)
      if (style) el.setAttribute('style', style)
      else el.removeAttribute(attr.name)
      continue
    }
    if (SVG_NS_ATTRIBUTES.test(name) || !SVG_ATTRIBUTES.has(name) || !svgValueOk(name, value)) el.removeAttribute(attr.name)
  }
}

function cleanSvgChildren(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue
    if (child.nodeType !== 1) {
      child.parentNode?.removeChild(child)
      continue
    }
    const el = child as El
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') {
      cleanSvgChildren(el)
      unwrap(el)
      continue
    }
    if (NEVER.has(tag) || !SVG_ELEMENTS.has(tag)) {
      el.remove()
      continue
    }
    cleanSvgAttributes(el, false)
    cleanSvgChildren(el)
  }
}

/** Whether an SVG draws anything (a sprite sheet of only definitions does not, and would leave an empty box). */
function drawsSomething(svg: El): boolean {
  return Array.from(svg.children).some((c) => !/^(defs|symbol|title|desc|lineargradient|radialgradient|clippath|mask|pattern|marker)$/.test(c.tagName.toLowerCase()))
}

/**
 * An inline <svg> sanitized in place: allowlisted elements and attributes only, `href` only as a fragment of this
 * document (on <use> and paint servers), url() only as a fragment, no style but the root's size and vertical
 * alignment. Returns false when it should go (it draws nothing).
 */
export function cleanSvg(svg: El): boolean {
  // The size the page showed it at (often set by CSS the reader view doesn't keep); none at all if it was hidden.
  const shown = SHOWN_SIZE.exec(svg.getAttribute(SHOWN_SIZE_ATTRIBUTE) ?? '')
  cleanSvgAttributes(svg, true)
  cleanSvgChildren(svg)
  if (shown) {
    const [width, height] = [Number(shown[1]), Number(shown[2])]
    if (width === 0 || height === 0) return false
    if (!svg.hasAttribute('width') && !svg.hasAttribute('height') && !/width|height/.test(svg.getAttribute('style') ?? '')) {
      svg.setAttribute('width', String(width))
      svg.setAttribute('height', String(height))
    }
  }
  return drawsSomething(svg)
}

const SHOWN_SIZE = /^(\d{1,5}(?:\.\d{1,2})?) (\d{1,5}(?:\.\d{1,2})?)$/

function cleanMathChildren(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue
    if (child.nodeType !== 1) {
      child.parentNode?.removeChild(child)
      continue
    }
    const el = child as El
    const tag = el.tagName.toLowerCase()
    if (NEVER.has(tag) || tag === 'svg') {
      el.remove()
      continue
    }
    cleanMathChildren(el)
    if (!MATH_ELEMENTS.has(tag)) {
      unwrap(el)
      continue
    }
    cleanMathAttributes(el)
  }
}

function cleanMathAttributes(el: El): void {
  const variant = el.getAttribute('mathvariant')?.trim().toLowerCase()
  if (variant && variant !== 'normal' && VARIANTS[variant] && el.children.length === 0) {
    el.textContent = mathVariantText(el.textContent ?? '', variant)
    el.removeAttribute('mathvariant')
    // A single letter of a token is italic by default; the Unicode letter carries its own style now.
    if (el.tagName.toLowerCase() === 'mi') el.setAttribute('mathvariant', 'normal')
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!MATH_ATTRIBUTES.has(name) || !MATH_VALUE.test(attr.value)) el.removeAttribute(attr.name)
  }
}

/** A <math> sanitized in place: presentation MathML elements and attributes only (no href, no annotations, no HTML). */
export function cleanMath(math: El): void {
  cleanMathAttributes(math)
  cleanMathChildren(math)
}

/** At most this many definitions are copied into formulas that use a shared glyph cache. */
const MAX_COPIED_DEFS = 5000

function refOf(use: El): string | null {
  const href = (use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '').trim()
  return FRAGMENT.test(href) ? href.slice(1) : null
}

/**
 * Each <svg> that <use>s a definition kept elsewhere in the page (MathJax's global glyph cache, an icon sprite) gets
 * a copy of it in its own <defs>, so it still draws once the article is cut out of the page.
 */
function copySharedDefinitions(document: Document): void {
  let copied = 0
  const byId = new Map<string, El>()
  for (const el of Array.from(document.querySelectorAll('[id]'))) if (!byId.has(el.id)) byId.set(el.id, el)
  for (const svg of Array.from(document.querySelectorAll('svg'))) {
    const have = new Set(Array.from(svg.querySelectorAll('[id]')).map((e) => e.id))
    let defs: El | null = null
    const pending: El[] = Array.from(svg.querySelectorAll('use'))
    while (pending.length > 0 && copied < MAX_COPIED_DEFS) {
      const id = refOf(pending.shift()!)
      if (!id || have.has(id)) continue
      const target = byId.get(id)
      if (!target || target.contains(svg)) continue
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs') as unknown as El
        svg.insertBefore(defs, svg.firstChild)
      }
      const copy = target.cloneNode(true) as El
      defs.appendChild(copy)
      have.add(id)
      for (const inner of Array.from(copy.querySelectorAll('[id]'))) have.add(inner.id)
      copied++
      pending.push(...Array.from(copy.querySelectorAll('use')))
      if (copy.tagName.toLowerCase() === 'use') pending.push(copy)
    }
  }
}

function replaceWith(el: El, replacement: El, block: boolean): void {
  const document = el.ownerDocument
  if (block) {
    const div = document.createElement('div')
    div.appendChild(replacement)
    el.replaceWith(div)
  } else {
    el.replaceWith(replacement)
  }
}

function showMath(math: El, block: boolean): El {
  if (block) math.setAttribute('display', 'block')
  math.removeAttribute('aria-hidden')
  for (const a of Array.from(math.querySelectorAll('annotation, annotation-xml'))) a.remove()
  return math
}

/**
 * The page's formulas reduced to what renders without its CSS and fonts, before Readability cuts the article out:
 * KaTeX and MathJax CHTML become their MathML; MathJax SVG keeps its SVG (glyphs from a shared cache copied in) and
 * drops the hidden MathML copy; Wikipedia's formulas become their MathML instead of the hidden copy and the picture.
 * Inline SVG and MathML lose `aria-hidden` (Readability drops hidden nodes). A canvas the page reader copied becomes
 * its picture; icon glyphs it drew stay as they are (the sanitizer turns them into images).
 *
 * Readability judges a block by its text, and a formula has little or none (an SVG has no text at all): a block made
 * of formulas would be dropped as empty. So each formula is set aside, a placeholder with some text stands in for it,
 * and `restoreMarkup` puts it back in the article. Returns the formulas set aside, in placeholder order.
 */
export function prepareMarkup(document: Document): string[] {
  copySharedDefinitions(document)
  for (const canvas of Array.from(document.querySelectorAll(`canvas[${CANVAS_ATTRIBUTE}]`))) {
    const img = canvasImage(canvas)
    if (img) canvas.replaceWith(img)
  }
  for (const el of Array.from(document.querySelectorAll('.MathJax_Preview, script[type^="math/"]'))) el.remove()
  for (const el of Array.from(document.querySelectorAll('.katex'))) {
    const math = el.querySelector('math')
    if (!el.isConnected || !math) continue
    const block = el.parentElement?.classList.contains('katex-display') === true || math.getAttribute('display') === 'block'
    replaceWith(el.parentElement?.classList.contains('katex-display') ? el.parentElement : el, showMath(math, block), block)
  }
  for (const el of Array.from(document.querySelectorAll('mjx-container'))) {
    if (!el.isConnected) continue
    const block = el.getAttribute('display') === 'true'
    const svg = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'svg')
    const math = el.querySelector('math')
    if (svg) {
      svg.removeAttribute('aria-hidden')
      if (block) svg.setAttribute('style', `${svg.getAttribute('style') ?? ''}; display: block; margin: 0.6em auto`)
      el.replaceWith(svg)
    } else if (math) {
      replaceWith(el, showMath(math, block), block)
    }
  }
  // MathJax 2: the rendering next to an assistive MathML copy.
  for (const el of Array.from(document.querySelectorAll('.MathJax, .MathJax_SVG, .MathJax_CHTML, .MathJax_Display'))) {
    const math = el.isConnected ? el.querySelector('.MJX_Assistive_MathML math, math') : null
    if (math) replaceWith(el, showMath(math, el.classList.contains('MathJax_Display') || math.getAttribute('display') === 'block'), el.classList.contains('MathJax_Display'))
  }
  for (const el of Array.from(document.querySelectorAll('.mwe-math-element'))) {
    const math = el.isConnected ? el.querySelector('math') : null
    if (math) replaceWith(el, showMath(math, math.getAttribute('display') === 'block'), math.getAttribute('display') === 'block')
  }
  for (const el of Array.from(document.querySelectorAll('svg[aria-hidden], math[aria-hidden]'))) el.removeAttribute('aria-hidden')
  const formulas: string[] = []
  for (const el of Array.from(document.querySelectorAll('svg, math'))) {
    // Only the outermost: a formula inside another goes with it.
    if (!el.isConnected || el.parentElement?.closest('svg, math')) continue
    const placeholder = document.createElement('span')
    placeholder.setAttribute(FORMULA_ATTRIBUTE, String(formulas.length))
    placeholder.textContent = `[formula ${formulas.length} set aside for the reader view]`
    formulas.push(el.outerHTML)
    el.replaceWith(placeholder)
  }
  return formulas
}

const FORMULA_ATTRIBUTE = 'data-research-formula'

/** The formulas `prepareMarkup` set aside, back in place of their placeholders in the article Readability found. */
export function restoreMarkup(document: Document, formulas: readonly string[]): void {
  for (const placeholder of Array.from(document.querySelectorAll(`span[${FORMULA_ATTRIBUTE}]`))) {
    const formula = formulas[Number(placeholder.getAttribute(FORMULA_ATTRIBUTE))]
    if (formula === undefined) {
      placeholder.remove()
      continue
    }
    const holder = document.createElement('div')
    holder.innerHTML = formula
    placeholder.replaceWith(...Array.from(holder.childNodes))
  }
}


/** The attributes the page reader leaves on an icon glyph (see shared/pageCapture/glyphs). */
const GLYPH_SRC = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/
const GLYPH_BOX = /^(\d{1,4}(?:\.\d{1,2})?) (\d{1,4}(?:\.\d{1,2})?) (\d{1,4}(?:\.\d{1,2})?)$/
const MAX_GLYPH = 64 * 1024

/** The inline image an annotated icon glyph becomes in the reader view; null when its attributes are not valid. */
export function glyphImage(el: El, src: string | null, box: string | null): El | null {
  if (!src || src.length > MAX_GLYPH || !GLYPH_SRC.test(src)) return null
  const m = GLYPH_BOX.exec(box ?? '')
  if (!m) return null
  const [width, height, descent] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (width <= 0 || height <= 0 || width > 512 || height > 512) return null
  const img = el.ownerDocument.createElement('img')
  img.setAttribute('src', src)
  img.setAttribute('alt', '')
  img.setAttribute('class', 'glyph')
  img.setAttribute('style', `width: ${width}px; height: ${height}px; vertical-align: -${descent}px`)
  return img
}

const CANVAS_SRC = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_CANVAS = 2 * 1024 * 1024

/** The <img> a canvas the page reader copied becomes, at the width it was shown at; null when its copy is not valid. */
function canvasImage(canvas: El): El | null {
  const src = canvas.getAttribute(CANVAS_ATTRIBUTE) ?? ''
  if (src.length > MAX_CANVAS || !CANVAS_SRC.test(src)) return null
  const img = canvas.ownerDocument.createElement('img')
  img.setAttribute('src', src)
  img.setAttribute('alt', canvas.getAttribute('aria-label') ?? '')
  const shown = SHOWN_SIZE.exec(canvas.getAttribute(SHOWN_SIZE_ATTRIBUTE) ?? '')
  if (shown) {
    img.setAttribute('width', String(Math.round(Number(shown[1]))))
    img.setAttribute('height', String(Math.round(Number(shown[2]))))
  }
  return img
}

/** Where each letter run of a `mathvariant` starts in Unicode's Mathematical Alphanumeric Symbols: A, a, 0. */
const VARIANTS: Record<string, [number, number, number | null]> = {
  bold: [0x1d400, 0x1d41a, 0x1d7ce],
  italic: [0x1d434, 0x1d44e, null],
  'bold-italic': [0x1d468, 0x1d482, null],
  script: [0x1d49c, 0x1d4b6, null],
  'bold-script': [0x1d4d0, 0x1d4ea, null],
  fraktur: [0x1d504, 0x1d51e, null],
  'double-struck': [0x1d538, 0x1d552, 0x1d7d8],
  'bold-fraktur': [0x1d56c, 0x1d586, null],
  'sans-serif': [0x1d5a0, 0x1d5ba, 0x1d7e2],
  'bold-sans-serif': [0x1d5d4, 0x1d5ee, 0x1d7ec],
  'sans-serif-italic': [0x1d608, 0x1d622, null],
  'sans-serif-bold-italic': [0x1d63c, 0x1d656, null],
  monospace: [0x1d670, 0x1d68a, 0x1d7f6]
}

/** Letters that Unicode had before that block, so the block leaves them out (ℝ, ℋ, ℜ…). */
const VARIANT_HOLES: Record<string, Record<string, number>> = {
  italic: { h: 0x210e },
  script: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 },
  fraktur: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  'double-struck': { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 }
}

/**
 * Text in a MathML `mathvariant` («double-struck» R) as the Unicode letter that shows it (ℝ): MathML Core, which
 * Chromium implements, ignores every mathvariant but «normal». Latin letters and digits only; the rest stays.
 */
export function mathVariantText(text: string, variant: string): string {
  const run = VARIANTS[variant]
  if (!run) return text
  const holes = VARIANT_HOLES[variant] ?? {}
  return Array.from(text)
    .map((c) => {
      if (holes[c]) return String.fromCodePoint(holes[c])
      const code = c.charCodeAt(0)
      if (c.length === 1 && code >= 65 && code <= 90) return String.fromCodePoint(run[0] + code - 65)
      if (c.length === 1 && code >= 97 && code <= 122) return String.fromCodePoint(run[1] + code - 97)
      if (c.length === 1 && code >= 48 && code <= 57 && run[2] !== null) return String.fromCodePoint(run[2] + code - 48)
      return c
    })
    .join('')
}
