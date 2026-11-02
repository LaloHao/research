import { parseHTML } from 'linkedom'

/**
 * «Página tal como se ve» from the browser extension: the extension serializes the live page in the user's browser
 * into one self-contained HTML document (styles inlined, fonts and images as data: URIs, scripts gone) and the app
 * prints it. That document is untrusted. Here it is cleaned once more (nothing active survives, nothing points to the
 * network) and given a policy that lets it load only its own inline styles and data: images, fonts and media; it is
 * printed in a window without JavaScript whose session refuses every request but the document (see ./print).
 */

/** What the printed page may load: its inline styles, and data: images, fonts and media. No scripts, frames or objects. */
export const PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:"

/** Removed with their content: anything that runs, embeds another document or changes how the document loads. */
const REMOVED = ['script', 'noscript', 'object', 'embed', 'applet', 'frame', 'frameset', 'portal', 'base', 'link', 'meta[http-equiv]', 'param'].join(',')

/** Attributes holding a URL; only data: (images, fonts, media) and, for links, web and mail addresses stay. */
const URL_ATTRIBUTES = ['src', 'srcset', 'poster', 'data', 'background', 'action', 'formaction', 'ping', 'xlink:href', 'href', 'longdesc', 'manifest', 'codebase', 'archive', 'lowsrc', 'dynsrc']
const DATA_URI = /^data:(image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/[\w.+-]+|application\/(font-[\w.+-]+|x-font-[\w.+-]+|vnd\.ms-fontobject)|audio\/[\w.+-]+|video\/[\w.+-]+)[;,]/i
const LINK = /^(https?:|mailto:|#)/i

/** Nested documents (same-site frames the extension inlined as srcdoc) are cleaned too, this deep at most. */
const MAX_FRAME_DEPTH = 3

function cleanAttributes(el: Element): void {
  const tag = el.tagName.toLowerCase()
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const value = attr.value.trim()
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'srcdoc' || !URL_ATTRIBUTES.includes(name)) continue
    // A link keeps a web address (the PDF keeps it clickable); an SVG reference may point inside the document.
    if ((name === 'href' && (tag === 'a' || tag === 'area') && LINK.test(value)) || ((name === 'href' || name === 'xlink:href') && value.startsWith('#'))) continue
    if ((name === 'src' || name === 'poster' || name === 'href' || name === 'xlink:href') && DATA_URI.test(value)) continue
    if (name === 'srcset' && value.split(',').every((part) => DATA_URI.test(part.trim()))) continue
    el.removeAttribute(attr.name)
  }
}

function cleanDocument(document: Document, depth: number): void {
  for (const el of Array.from(document.querySelectorAll(REMOVED))) el.remove()
  for (const el of Array.from(document.querySelectorAll('*'))) {
    cleanAttributes(el)
    if (el.tagName.toLowerCase() !== 'iframe') continue
    const srcdoc = el.getAttribute('srcdoc')
    if (srcdoc !== null && depth < MAX_FRAME_DEPTH) el.setAttribute('srcdoc', sanitizePageHtml(srcdoc, depth + 1))
    else el.removeAttribute('srcdoc')
  }
}

/**
 * The serialized page, safe to load: scripts, <noscript> (which would show without scripts), objects, embeds, frames
 * without inlined content, <base>, every <link> and every http-equiv <meta> (refresh, policies) removed; event handler
 * attributes and every URL but data: resources, fragment references and links removed; frames inlined as srcdoc
 * cleaned the same way; `PAGE_CSP` and the charset first in <head>.
 */
export function sanitizePageHtml(html: string, depth = 0): string {
  let { document } = parseHTML(html)
  // A fragment (a frame's srcdoc can be one) gets a document around it.
  if (document.documentElement?.tagName.toLowerCase() !== 'html') document = parseHTML(`<html><head></head><body>${html}</body></html>`).document
  const doc = document as unknown as Document
  cleanDocument(doc, depth)
  let head = doc.head as Element | null
  if (!head) {
    head = doc.createElement('head')
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild)
  }
  for (const meta of Array.from(head.querySelectorAll('meta[charset]'))) meta.remove()
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', PAGE_CSP)
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  head.insertBefore(csp, head.firstChild)
  head.insertBefore(charset, head.firstChild)
  return document.toString()
}
