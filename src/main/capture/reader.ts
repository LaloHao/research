import { parseHTML } from 'linkedom'
import type { WebArticle } from '../ingest/web'

/**
 * The reader view of a captured page: the article Readability found, sanitized, under a header that says where it came
 * from, as a plain document the app prints to PDF instead of the live page (which carries cookie banners, ads and
 * navigation). The article's HTML is untrusted: only a small allowlist of tags and attributes survives, links and
 * images are made absolute, and images end up embedded as data: URIs so the printing window never touches the network.
 */

/** Removed with everything inside: active content, embedded documents, forms, media and the page's own styles. */
const DROPPED = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'form', 'input',
  'button', 'select', 'option', 'textarea', 'label', 'fieldset', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track',
  'link', 'meta', 'base', 'head', 'title', 'dialog', 'portal', 'slot', 'map', 'area'
])

const NUMBER = /^\d{1,4}$/

/** The tags kept, each with the attributes it may carry (checked by `keepAttribute`); any other tag is unwrapped. */
const ALLOWED: Record<string, readonly string[]> = {
  article: [], section: [], div: [], span: [], p: [], br: [], hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start', 'reversed'], li: ['value'], dl: [], dt: [], dd: [],
  blockquote: [], q: [], cite: [], pre: [], code: [], kbd: [], samp: [], var: [],
  em: [], strong: [], b: [], i: [], u: [], s: [], del: [], ins: [], sub: [], sup: [], small: [], mark: [], abbr: ['title'], time: ['datetime'],
  figure: [], figcaption: [], img: ['src', 'alt', 'width', 'height'],
  table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'],
  colgroup: ['span'], col: ['span'],
  a: ['href']
}

const NUMERIC = new Set(['start', 'value', 'width', 'height', 'colspan', 'rowspan', 'span'])
const SCOPES = new Set(['row', 'col', 'rowgroup', 'colgroup'])

/** Images that may stay inline as data: (the page's own small embedded pictures); anything else is fetched or dropped. */
const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i
const MAX_INLINE_IMAGE = 2 * 1024 * 1024

type El = Element

function absolute(value: string, base: string, protocols: readonly string[]): string | null {
  try {
    const url = new URL(value.trim(), base)
    return protocols.includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** The picture an <img> shows: its src, or a lazy-loading attribute, or the first candidate of its srcset. */
function imageSource(img: El): string {
  const src = img.getAttribute('src')?.trim() ?? ''
  if (src && !src.startsWith('data:')) return src
  for (const name of ['data-src', 'data-original', 'data-lazy-src']) {
    const lazy = img.getAttribute(name)?.trim()
    if (lazy) return lazy
  }
  const srcset = (img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? '').trim()
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0]
  return first || src
}

function keepAttribute(name: string, value: string): boolean {
  if (NUMERIC.has(name)) return NUMBER.test(value.trim())
  if (name === 'scope') return SCOPES.has(value.trim().toLowerCase())
  if (name === 'reversed') return true
  return true
}

function unwrap(el: El): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  el.remove()
}

function cleanChildren(node: Node, base: string): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue
    if (child.nodeType !== 1) {
      // Comments, processing instructions, CDATA: nothing a reader needs.
      child.parentNode?.removeChild(child)
      continue
    }
    const el = child as El
    const tag = el.tagName.toLowerCase()
    if (DROPPED.has(tag)) {
      el.remove()
      continue
    }
    const allowed = ALLOWED[tag]
    if (!allowed) {
      cleanChildren(el, base)
      unwrap(el)
      continue
    }
    if (tag === 'img') {
      const raw = imageSource(el)
      const src = INLINE_IMAGE.test(raw) && raw.length <= MAX_INLINE_IMAGE ? raw : absolute(raw, base, ['http:', 'https:'])
      if (!src) {
        el.remove()
        continue
      }
      el.setAttribute('src', src)
    }
    if (tag === 'a') {
      const href = el.getAttribute('href')
      const target = href ? absolute(href, base, ['http:', 'https:', 'mailto:']) : null
      if (target) el.setAttribute('href', target)
      else el.removeAttribute('href')
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!allowed.includes(name) || !keepAttribute(name, attr.value)) el.removeAttribute(attr.name)
    }
    cleanChildren(el, base)
  }
}

/**
 * The article's HTML with only safe markup left: no scripts, styles, event handlers, frames, forms, objects or media,
 * no class/id/style attributes; links and images absolute (http/https; mailto for links), images without a usable
 * source removed. `base` is the page's URL.
 */
export function sanitizeArticle(html: string, base: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
  cleanChildren(document.body, base)
  return document.body.innerHTML
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** The policy of the printed document: nothing but its own inline style and data: images. */
export const READER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** Serif body at a readable width; margins and page numbers come from the print options. Link URLs are not expanded. */
export const READER_CSS = `
html { background: #fff; }
body { margin: 0 auto; max-width: 155mm; color: #111; font-family: "Noto Serif", "DejaVu Serif", "Liberation Serif", Georgia, "Times New Roman", serif;
  font-size: 11pt; line-height: 1.5; overflow-wrap: break-word; }
header.source { border-bottom: 1px solid #999; margin-bottom: 1.2em; padding-bottom: 0.6em; }
header.source .site { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin: 0; }
header.source h1 { font-size: 20pt; line-height: 1.2; margin: 0.25em 0; }
header.source .byline, header.source .date { margin: 0.1em 0; font-size: 10.5pt; }
header.source .origin { margin: 0.5em 0 0; font-size: 8.5pt; color: #444; word-break: break-all; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; break-after: avoid; page-break-after: avoid; margin: 1.1em 0 0.4em; }
h1 { font-size: 17pt; } h2 { font-size: 14.5pt; } h3 { font-size: 12.5pt; } h4, h5, h6 { font-size: 11pt; }
p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
a { color: inherit; text-decoration: underline; }
img { display: block; max-width: 100%; height: auto; margin: 0.6em auto; break-inside: avoid; page-break-inside: avoid; }
figure { margin: 1em 0; break-inside: avoid; page-break-inside: avoid; }
figcaption { font-size: 9pt; color: #444; text-align: center; }
blockquote { margin: 0.8em 0 0.8em 1em; padding-left: 0.8em; border-left: 2px solid #bbb; color: #333; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 8.5pt; line-height: 1.35; border-left: 2px solid #ccc; padding: 0.2em 0 0.2em 0.7em; }
code, kbd, samp { font-family: "DejaVu Sans Mono", "Liberation Mono", Consolas, monospace; font-size: 0.88em; }
pre code { font-size: inherit; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 0.8em 0; }
th, td { border: 1px solid #999; padding: 3px 5px; vertical-align: top; text-align: left; }
caption { font-size: 9pt; color: #444; caption-side: bottom; padding-top: 0.3em; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.15em 0; }
hr { border: 0; border-top: 1px solid #bbb; margin: 1.2em 0; }
`

export interface ReaderSource {
  /** The page's final URL. */
  url: string
  /** When the page was captured. */
  accessed: Date
}

/**
 * The document printed as the paper's PDF: a header with the site, title, byline, date, source URL and access date,
 * then the article (already sanitized). Everything from the page is escaped or comes from `sanitizeArticle`. A first
 * heading that repeats the title is left out.
 */
export function buildReaderHtml(article: Pick<WebArticle, 'title' | 'byline' | 'site' | 'date'>, content: string, source: ReaderSource): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${content}</body></html>`)
  const first = document.body.querySelector('h1, h2')
  if (first && normalized(first.textContent ?? '') === normalized(article.title)) first.remove()
  const accessed = source.accessed.toISOString().slice(0, 10)
  const line = (cls: string, text: string): string => (text.trim() ? `<p class="${cls}">${escapeHtml(text.trim())}</p>` : '')
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">`,
    `<title>${escapeHtml(article.title)}</title>`,
    `<style>${READER_CSS}</style>`,
    '</head>',
    '<body>',
    '<header class="source">',
    line('site', article.site),
    `<h1>${escapeHtml(article.title)}</h1>`,
    line('byline', article.byline),
    line('date', article.date ?? ''),
    `<p class="origin">Source: ${escapeHtml(source.url)} · Accessed: ${accessed}</p>`,
    '</header>',
    `<main>${document.body.innerHTML}</main>`,
    '</body>',
    '</html>'
  ]
    .filter(Boolean)
    .join('\n')
}

/** Limits of the images embedded in a reader PDF; past them, images are left out (the text stays). */
export const READER_IMAGE_LIMITS = { count: 40, bytes: 5 * 1024 * 1024, total: 30 * 1024 * 1024 }

/** The image type its first bytes show; SVG and anything unknown are refused. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | null {
  const at = (i: number, ...values: number[]): boolean => values.every((v, k) => bytes[i + k] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'avif'
  return null
}

/** Loopback, private and link-local hosts: an article's image there is only fetched when the page itself is on that host. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return host.includes(':') && (/^f[cd]/.test(host) || host.startsWith('fe80') || host.startsWith('::ffff:'))
}

/** Fetches one image (through the page's own session); null when it can't, or when it is larger than `maxBytes`. */
export type ImageFetcher = (url: string, maxBytes: number) => Promise<Uint8Array | null>

/**
 * Replaces each image of a reader document with a data: copy fetched through `fetchImage`, so the printing window
 * needs no network. Only http/https images found in the article, on the page's host or a public host, real raster
 * images (sniffed, never SVG), within `READER_IMAGE_LIMITS`; any other image is removed.
 */
export async function embedImages(html: string, pageUrl: string, fetchImage: ImageFetcher, limits = READER_IMAGE_LIMITS): Promise<string> {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
  const pageHost = new URL(pageUrl).hostname.toLowerCase()
  const fetched = new Map<string, string | null>()
  let count = 0
  let total = 0
  for (const img of Array.from(document.body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (INLINE_IMAGE.test(src)) continue
    let data = fetched.get(src)
    if (data === undefined) {
      data = null
      let url: URL | null = null
      try {
        url = new URL(src)
      } catch {
        url = null
      }
      const allowed = url && (url.protocol === 'https:' || url.protocol === 'http:') && (url.hostname.toLowerCase() === pageHost || !isPrivateHost(url.hostname))
      if (allowed && count < limits.count && total < limits.total) {
        count++
        const bytes = await fetchImage(src, Math.min(limits.bytes, limits.total - total)).catch(() => null)
        const type = bytes ? sniffImage(bytes) : null
        if (bytes && type && bytes.byteLength <= limits.bytes && total + bytes.byteLength <= limits.total) {
          total += bytes.byteLength
          data = `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`
        }
      }
      fetched.set(src, data)
    }
    if (data) img.setAttribute('src', data)
    else img.remove()
  }
  return document.body.innerHTML
}
