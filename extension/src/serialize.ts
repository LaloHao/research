/**
 * «Página tal como se ve»: the live page as one self-contained HTML document, made in the page (the content script)
 * so it has what the user sees: the DOM as scripts left it, form values, canvases, every stylesheet (also those
 * inserted through the CSSOM), the fonts and images the browser loaded with the user's session. Styles are inlined
 * with their url()s as data: URIs (only the fonts the page really uses), images too (the one the browser chose from a
 * srcset), canvases become images, same-site frames are serialized into srcdoc, and scripts, <noscript>, event
 * handlers and cookie-consent overlays go. Nothing is changed on the page itself: everything happens on a copy.
 *
 * The app treats the result as untrusted: it cleans it again and prints it without JavaScript or network.
 */
import { CONSENT_CSS, CONSENT_SELECTORS, OVERLAY_NAME } from '../../src/shared/pageCapture/consent'
import { isSvgBytes, LIMITS, sniffFont, sniffImage, toBase64 } from './detect'

export interface Fetched {
  bytes: Uint8Array
}

/** Fetches a resource of the page with its credentials; null when it can't, or when it is larger than `maxBytes`. */
export type ResourceFetcher = (url: string, maxBytes: number) => Promise<Fetched | null>

export const SERIALIZE_LIMITS = {
  /** The document sent (characters). */
  html: LIMITS.pageHtml,
  /** One font or image inlined (bytes). */
  resource: 8 * 1024 * 1024,
  /** All the fonts and images inlined together (bytes; base64 makes them a third larger). */
  total: 30 * 1024 * 1024,
  /** How many fonts and images are inlined at most. */
  resources: 600,
  /** One stylesheet's text (characters). */
  css: 5 * 1024 * 1024,
  /** How deep stylesheets import others, and frames nest, are followed. */
  imports: 5,
  frames: 2
} as const

export interface SerializeOptions {
  doc: Document
  /** For computed styles and the window width; without it (tests), live state that needs them is skipped. */
  view?: Pick<Window, 'getComputedStyle' | 'innerWidth' | 'innerHeight'> | null
  fetch: ResourceFetcher
  limits?: Partial<Limits>
}

export interface SerializedPage {
  html: string
  /** The width the page was laid out at (CSS pixels). */
  viewportWidth: number
  /** Fonts and images left as links (failed, too large, past the limits): they won't show in the PDF. */
  missing: number
}

export class PageTooLargeError extends Error {
  constructor() {
    super('too_large')
    this.name = 'PageTooLargeError'
  }
}

/** A meta tag the serialized page carries with the width it was laid out at. */
export const VIEWPORT_META = 'research-viewport-width'

/** The attribute marking elements of the copy to remove (consent overlays found on the live page). */
const DROP = 'data-research-drop'

const URL_IN_CSS = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]+))\s*\)/g
const IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/g
const FONT_FACE = /@font-face\s*\{[^}]*\}/g
const FONT_FORMATS = /^(woff2|woff|truetype|opentype)(-variations)?$/

type Limits = { [K in keyof typeof SERIALIZE_LIMITS]: number }

/** Inlines fonts and images as data: URIs, each URL once, within the limits. */
class Inliner {
  private readonly cache = new Map<string, Promise<string | null>>()
  private bytes = 0
  private count = 0
  missing = 0

  constructor(
    private readonly fetch: ResourceFetcher,
    private readonly limits: Limits
  ) {}

  image(url: string): Promise<string | null> {
    return this.inline(url, 'image')
  }

  font(url: string): Promise<string | null> {
    return this.inline(url, 'font')
  }

  private inline(url: string, kind: 'image' | 'font'): Promise<string | null> {
    const key = `${kind} ${url}`
    let found = this.cache.get(key)
    if (!found) {
      found = this.load(url, kind)
      this.cache.set(key, found)
    }
    return found
  }

  private async load(url: string, kind: 'image' | 'font'): Promise<string | null> {
    if (!/^https?:/i.test(url) || this.count >= this.limits.resources || this.bytes >= this.limits.total) {
      this.missing++
      return null
    }
    this.count++
    const max = Math.min(this.limits.resource, this.limits.total - this.bytes)
    const got = await this.fetch(url, max).catch(() => null)
    const bytes = got?.bytes
    const type = bytes ? (kind === 'font' ? fontMime(bytes) : imageMime(bytes)) : null
    if (!bytes || !type || bytes.byteLength > max) {
      this.missing++
      return null
    }
    this.bytes += bytes.byteLength
    return `data:${type};base64,${toBase64(bytes)}`
  }
}

function fontMime(bytes: Uint8Array): string | null {
  const type = sniffFont(bytes)
  return type ? `font/${type}` : null
}

function imageMime(bytes: Uint8Array): string | null {
  const raster = sniffImage(bytes)
  if (raster) return `image/${raster}`
  return isSvgBytes(bytes) ? 'image/svg+xml' : null
}

function absolute(value: string, base: string): string | null {
  try {
    return new URL(value, base).href
  } catch {
    return null
  }
}

const unescapeCss = (value: string): string => value.replace(/\\(.)/g, '$1')

async function replaceAsync(text: string, pattern: RegExp, replace: (match: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: (string | Promise<string>)[] = []
  let last = 0
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    parts.push(text.slice(last, m.index), replace(m))
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return (await Promise.all(parts)).join('')
}

/** The family names the page has loaded fonts for (lowercase); null when the browser doesn't say (keep them all). */
function loadedFamilies(doc: Document): Set<string> | null {
  const fonts = (doc as Document & { fonts?: Iterable<FontFace> }).fonts
  if (!fonts || typeof (fonts as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') return null
  const families = new Set<string>()
  for (const face of fonts) if (face.status === 'loaded') families.add(face.family.replace(/^["']|["']$/g, '').toLowerCase())
  return families
}

class CssInliner {
  constructor(
    private readonly inliner: Inliner,
    private readonly fetchText: (url: string) => Promise<string | null>,
    private readonly families: Set<string> | null,
    private readonly limits: Limits
  ) {}

  /** A stylesheet's text with its imports pulled in and its fonts and images as data: URIs. */
  async process(css: string, base: string, depth = 0): Promise<string> {
    const imported = await replaceAsync(css, IMPORT, async (m) => {
      const href = absolute(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '', base)
      if (!href || depth >= this.limits.imports) return ''
      const text = await this.fetchText(href)
      if (text === null) return ''
      const inner = await this.process(text, href, depth + 1)
      const media = (m[6] ?? '').trim()
      // `layer(…)` and `supports(…)` conditions are rare; the rules then apply unconditionally.
      return media && !/^(layer|supports)\b/i.test(media) ? `@media ${media} {\n${inner}\n}` : inner
    })
    // @font-face blocks get their font; everything else its images.
    const segments: { text: string; face: boolean }[] = []
    let last = 0
    FONT_FACE.lastIndex = 0
    for (let m = FONT_FACE.exec(imported); m; m = FONT_FACE.exec(imported)) {
      segments.push({ text: imported.slice(last, m.index), face: false }, { text: m[0], face: true })
      last = m.index + m[0].length
    }
    segments.push({ text: imported.slice(last), face: false })
    const done = await Promise.all(segments.map((segment) => (segment.face ? this.fontFace(segment.text, base) : this.images(segment.text, base))))
    return done.join('')
  }

  /** An @font-face: gone when the page doesn't use its family; else its first usable source inlined. */
  private async fontFace(block: string, base: string): Promise<string> {
    const family = /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(block)?.[2]?.trim().toLowerCase()
    if (this.families && family && !this.families.has(family)) return ''
    const sources: { match: string; url: string }[] = []
    URL_IN_CSS.lastIndex = 0
    for (let m = URL_IN_CSS.exec(block); m; m = URL_IN_CSS.exec(block)) {
      const raw = unescapeCss(m[1] ?? m[2] ?? m[3] ?? '')
      // Already inline: nothing to fetch.
      if (raw.startsWith('data:')) return block
      const url = absolute(raw, base)
      // In the order given, a source in a web font format (or none said, but not an .eot or .svg font).
      const format = /^\s*format\(\s*["']?([\w-]+)/i.exec(block.slice(m.index + m[0].length))?.[1]?.toLowerCase()
      const usable = format ? FONT_FORMATS.test(format) : !/\.(eot|svg)(\?|#|$)/i.test(raw)
      if (url && usable) sources.push({ match: m[0], url })
    }
    for (const source of sources) {
      const data = await this.inliner.font(source.url)
      if (data) return block.replace(source.match, `url("${data}")`)
    }
    return block
  }

  private images(css: string, base: string): Promise<string> {
    return replaceAsync(css, URL_IN_CSS, async (m) => {
      const raw = unescapeCss(m[1] ?? m[2] ?? m[3] ?? '')
      if (raw.startsWith('data:') || raw.startsWith('#')) return m[0]
      const url = absolute(raw, base)
      const data = url ? await this.inliner.image(url) : null
      if (data) return `url("${data}")`
      // Unresolved: absolute, so it can't point elsewhere by accident (the app blocks it anyway).
      return url ? `url("${url.replace(/"/g, '%22')}")` : 'url("")'
    })
  }
}

/** A stylesheet's text from the CSSOM (also rules a script inserted), when the browser lets the page read it. */
function rulesText(sheet: CSSStyleSheet | null | undefined): string | null {
  try {
    if (!sheet?.cssRules) return null
    return Array.from(sheet.cssRules)
      .map((rule) => rule.cssText)
      .join('\n')
  } catch {
    // Another site's stylesheet without CORS: fetched instead.
    return null
  }
}

function doctypeOf(doc: Document): string {
  const dt = doc.doctype
  if (!dt) return ''
  const pub = dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''
  const sys = dt.systemId ? `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"` : ''
  return `<!DOCTYPE ${dt.name}${pub}${sys}>`
}

const SKIPPED = 'script, noscript, template:not([shadowrootmode]), object, embed, applet, portal, base, link:not([rel~="stylesheet" i]), meta[http-equiv], source, track, audio'

/** The same overlays the app hides before printing: known consent containers, and fixed banners named like one. */
function isOverlay(el: Element, view: NonNullable<SerializeOptions['view']>): boolean {
  const style = view.getComputedStyle(el)
  if (style.position !== 'fixed' && style.position !== 'sticky') return false
  const label = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') ?? ''].join(' ')
  if (OVERLAY_NAME.test(label)) return true
  const box = el.getBoundingClientRect()
  const area = view.innerWidth * view.innerHeight
  return style.position === 'fixed' && area > 0 && box.width * box.height >= 0.8 * area && (el.textContent ?? '').trim().length === 0
}

/** The live page (`doc`) as one self-contained HTML document; throws `PageTooLargeError` past `limits.html`. */
export async function serializePage(options: SerializeOptions, depth = 0): Promise<SerializedPage> {
  const limits: Limits = { ...SERIALIZE_LIMITS, ...options.limits }
  const { doc, view } = options
  const inliner = new Inliner(options.fetch, limits)
  const decoder = new TextDecoder()
  const fetchText = async (url: string): Promise<string | null> => {
    const got = await options.fetch(url, limits.css).catch(() => null)
    return got ? decoder.decode(got.bytes) : null
  }
  const css = new CssInliner(inliner, fetchText, loadedFamilies(doc), limits)
  const base = doc.baseURI || doc.URL
  const root = doc.documentElement
  const live = Array.from(root.querySelectorAll('*'))
  const copy = root.cloneNode(true) as Element
  const copies = Array.from(copy.querySelectorAll('*'))
  const mapped = copies.length === live.length
  const work: Promise<void>[] = []

  if (mapped) {
    for (let i = 0; i < live.length; i++) {
      const el = live[i]!
      const out = copies[i]!
      const tag = el.tagName.toLowerCase()
      // Left out below anyway (a parser may have read <noscript> as markup).
      if (el.closest('noscript, template, script')) continue
      if (view && el.parentElement && isOverlay(el, view)) {
        out.setAttribute(DROP, '')
        continue
      }
      if (tag === 'input') {
        const input = el as HTMLInputElement
        const type = (input.type || 'text').toLowerCase()
        if (type === 'checkbox' || type === 'radio') {
          if (input.checked) out.setAttribute('checked', '')
          else out.removeAttribute('checked')
        } else if (type === 'password') {
          // Never what the user typed in a password field.
          out.removeAttribute('value')
        } else if (type !== 'file' && type !== 'hidden') {
          out.setAttribute('value', input.value)
        }
      } else if (tag === 'textarea') {
        out.textContent = (el as HTMLTextAreaElement).value
      } else if (tag === 'option') {
        if ((el as HTMLOptionElement).selected) out.setAttribute('selected', '')
        else out.removeAttribute('selected')
      } else if (tag === 'canvas') {
        let src: string | null = null
        try {
          src = (el as HTMLCanvasElement).toDataURL('image/png')
        } catch {
          src = null
        }
        const img = doc.createElement('img')
        for (const name of ['id', 'class', 'style', 'width', 'height']) {
          const value = out.getAttribute(name)
          if (value !== null) img.setAttribute(name, value)
        }
        if (src?.startsWith('data:image/png')) img.setAttribute('src', src)
        img.setAttribute('alt', '')
        out.replaceWith(img)
      } else if (tag === 'img') {
        const img = el as HTMLImageElement
        const src = img.currentSrc || img.getAttribute('src') || ''
        out.removeAttribute('srcset')
        out.removeAttribute('sizes')
        out.removeAttribute('loading')
        const url = src && !src.startsWith('data:') ? absolute(src, base) : null
        if (url) work.push(inliner.image(url).then((data) => (data ? out.setAttribute('src', data) : out.setAttribute('src', url))))
      } else if (tag === 'video') {
        const poster = (el as HTMLVideoElement).poster
        out.removeAttribute('src')
        out.removeAttribute('autoplay')
        if (poster) work.push(inliner.image(poster).then((data) => (data ? out.setAttribute('poster', data) : out.removeAttribute('poster'))))
      } else if (tag === 'iframe' || tag === 'frame') {
        out.removeAttribute('src')
        let frame: Document | null = null
        try {
          frame = (el as HTMLIFrameElement).contentDocument
        } catch {
          frame = null
        }
        if (frame?.documentElement && depth < limits.frames) {
          const frameView = (el as HTMLIFrameElement).contentWindow
          work.push(
            serializePage({ ...options, doc: frame, view: frameView, limits: { ...limits, total: Math.max(0, limits.total / 4) } }, depth + 1).then(
              (inner) => out.setAttribute('srcdoc', inner.html),
              () => undefined
            )
          )
        }
      } else if (el.shadowRoot && el.shadowRoot.mode === 'open' && !out.querySelector(':scope > template[shadowrootmode]')) {
        // Web components: their open shadow DOM as declarative shadow DOM (its styles as they are).
        const template = doc.createElement('template')
        template.setAttribute('shadowrootmode', 'open')
        for (const child of Array.from(el.shadowRoot.childNodes)) template.content.appendChild(child.cloneNode(true))
        out.insertBefore(template, out.firstChild)
      }
    }
  }

  // Stylesheets, in their order: each <style> and stylesheet <link> becomes a <style> with everything inlined.
  const sheets = live.map((el, i) => [el, copies[i]] as const).filter(([el]) => el.matches('style, link[rel~="stylesheet" i]'))
  for (const [el, out] of mapped ? sheets : []) {
    const isLink = el.tagName.toLowerCase() === 'link'
    const href = isLink ? absolute(el.getAttribute('href') ?? '', base) : null
    const media = el.getAttribute('media')
    work.push(
      (async () => {
        if (isLink && ((el as HTMLLinkElement).disabled || /\balternate\b/i.test(el.getAttribute('rel') ?? ''))) {
          out!.remove()
          return
        }
        let text = rulesText((el as HTMLStyleElement | HTMLLinkElement).sheet as CSSStyleSheet | null)
        if (text === null) text = isLink ? (href ? await fetchText(href) : null) : (el.textContent ?? '')
        const style = doc.createElement('style')
        if (media) style.setAttribute('media', media)
        style.textContent = text ? await css.process(text.slice(0, limits.css), href ?? base) : ''
        out!.replaceWith(style)
      })()
    )
  }
  // Styles the page's scripts constructed and adopted.
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []
  const adoptedStyles = adopted.map(async (sheet) => {
    const text = rulesText(sheet)
    return text ? css.process(text, base) : ''
  })
  // Inline style attributes with url()s.
  for (const out of copies) {
    const style = out.getAttribute('style')
    if (style && /url\(/i.test(style)) work.push(css.process(style, base).then((value) => out.setAttribute('style', value)))
  }
  await Promise.all(work)

  // What must not come along (the app removes it too): scripts, frames' remote sources, overlays, handlers.
  for (const el of Array.from(copy.querySelectorAll(`${SKIPPED}, [${DROP}], ${CONSENT_SELECTORS.join(', ')}`))) el.remove()
  for (const el of Array.from(copy.querySelectorAll('picture > source'))) el.remove()
  for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction') && /^\s*(javascript|vbscript):/i.test(attr.value))) el.removeAttribute(attr.name)
    }
    // Links keep working in the PDF: absolute.
    if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href') && !el.getAttribute('href')!.startsWith('#')) {
      const href = absolute(el.getAttribute('href')!, base)
      if (href) el.setAttribute('href', href)
      else el.removeAttribute('href')
    }
  }

  const head = copy.querySelector('head') ?? copy.insertBefore(doc.createElement('head'), copy.firstChild)
  for (const meta of Array.from(head.querySelectorAll('meta[charset]'))) meta.remove()
  const viewportWidth = Math.round(root.clientWidth || view?.innerWidth || 1280)
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const width = doc.createElement('meta')
  width.setAttribute('name', VIEWPORT_META)
  width.setAttribute('content', String(viewportWidth))
  head.insertBefore(width, head.firstChild)
  head.insertBefore(charset, head.firstChild)
  const last = doc.createElement('style')
  last.textContent = `${(await Promise.all(adoptedStyles)).join('\n')}\n${CONSENT_CSS}`
  ;(copy.querySelector('body') ?? copy).appendChild(last)

  const html = `${doctypeOf(doc)}${copy.outerHTML}`
  if (html.length > limits.html) throw new PageTooLargeError()
  return { html, viewportWidth, missing: inliner.missing }
}
