/**
 * What the extension reads from a page, without the browser APIs (so it is tested in Node against fixture HTML): its
 * citation meta tags, its DOI or arXiv id, a PDF link, whether the tab is a PDF, and the article's images. The page is
 * only read, never changed.
 */

/** Meta tags kept for the app, by name or property (lowercased). */
const META_PREFIXES = ['citation_', 'dc.', 'dcterms.', 'prism.', 'og:', 'article:', 'bepress_citation_', 'eprints.', 'highwire', 'wkhealth_']
const META_NAMES = new Set(['description', 'author', 'keywords'])
/** The limits the app accepts (see the app's extension payload). */
export const LIMITS = {
  html: 10 * 1024 * 1024,
  images: 40,
  imageBytes: 5 * 1024 * 1024,
  imagesTotal: 30 * 1024 * 1024,
  pdfBytes: 100 * 1024 * 1024,
  metaEntries: 300,
  metaValue: 4000,
  title: 2000
} as const

export type PageMeta = Record<string, string[]>

export type PageKind = 'pdf' | 'doi' | 'arxiv' | 'article'

export interface Detection {
  url: string
  title: string
  kind: PageKind
  doi: string | null
  arxiv: string | null
  /** The PDF to send: the tab itself when it is a PDF, else the page's citation_pdf_url (http/https). */
  pdfUrl: string | null
  isPdf: boolean
  authors: string[]
  date: string | null
  meta: PageMeta
}

/** The meta tags a scholarly page carries (Highwire/Google Scholar, Dublin Core, PRISM, Open Graph). */
export function readMeta(doc: Pick<Document, 'querySelectorAll'>): PageMeta {
  const meta: PageMeta = {}
  let count = 0
  for (const el of Array.from(doc.querySelectorAll('meta'))) {
    const name = (el.getAttribute('name') ?? el.getAttribute('property') ?? '').trim().toLowerCase()
    const content = el.getAttribute('content')?.trim()
    if (!name || !content || name.length > 100) continue
    if (!META_NAMES.has(name) && !META_PREFIXES.some((p) => name.startsWith(p))) continue
    if (!meta[name]) {
      if (count >= LIMITS.metaEntries) continue
      meta[name] = []
      count++
    }
    if (meta[name].length < 50) meta[name].push(content.slice(0, LIMITS.metaValue))
  }
  return meta
}

const DOI = /10\.\d{4,9}\/[^\s"'<>]+/
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i

export function cleanDoi(raw: string | undefined | null): string | null {
  const m = raw?.match(DOI)
  return m ? m[0].replace(/[.,;:)\]}>]+$/, '').toLowerCase() : null
}

export function cleanArxiv(raw: string | undefined | null): string | null {
  const m = raw?.trim().replace(/^arxiv:\s*/i, '').match(ARXIV_ID)
  return m ? m[1].toLowerCase() : null
}

/** An arXiv id from an arxiv.org abs/pdf/html URL. */
export function arxivFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)arxiv\.org$/i.test(u.hostname)) return null
    const m = decodeURIComponent(u.pathname).match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/)
    return m ? cleanArxiv(m[1]) : null
  } catch {
    return null
  }
}

/** A DOI from a doi.org link, or one in the path of a publisher's URL (…/doi/10.1145/…). */
export function doiFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return cleanDoi(decodeURIComponent(u.pathname))
  } catch {
    return null
  }
}

const DOI_FIELDS = ['citation_doi', 'prism.doi', 'dc.identifier', 'dc.identifier.doi', 'bepress_citation_doi', 'dcterms.identifier']

export function doiFromMeta(meta: PageMeta): string | null {
  for (const field of DOI_FIELDS) {
    for (const value of meta[field] ?? []) {
      // dc.identifier holds ISSNs and URLs too: only a DOI counts.
      const doi = cleanDoi(value)
      if (doi) return doi
    }
  }
  return null
}

const webUrl = (value: string | undefined, base: string): string | null => {
  if (!value) return null
  try {
    const u = new URL(value.trim(), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Whether the tab shows a PDF: its content type, or an address that serves one (…/x.pdf, arxiv.org/pdf/…). */
export function isPdfTab(url: string, contentType: string | null | undefined): boolean {
  if ((contentType ?? '').toLowerCase().split(';')[0]!.trim() === 'application/pdf') return true
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (/\.pdf$/i.test(u.pathname)) return true
    return /(^|\.)arxiv\.org$/i.test(u.hostname) && u.pathname.startsWith('/pdf/')
  } catch {
    return false
  }
}

/** Pages the browser never lets an extension read (its own pages, add-on stores) or that are not on the web. */
export function isCapturable(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return !['addons.mozilla.org', 'chromewebstore.google.com', 'chrome.google.com'].includes(u.hostname)
  } catch {
    return false
  }
}

/** Everything the popup shows and the capture sends, from the page as it is now. */
export function detect(doc: Pick<Document, 'querySelectorAll' | 'title'>, url: string, contentType: string | null): Detection {
  const isPdf = isPdfTab(url, contentType)
  const meta = isPdf ? {} : readMeta(doc)
  const doi = doiFromMeta(meta) ?? (/(^|\.)doi\.org$/i.test(hostOf(url)) ? doiFromUrl(url) : null)
  const arxiv = cleanArxiv(meta.citation_arxiv_id?.[0]) ?? arxivFromUrl(url)
  const pdfUrl = isPdf ? url : webUrl(meta.citation_pdf_url?.[0], url)
  const title = (meta.citation_title?.[0] ?? meta['dc.title']?.[0] ?? meta['og:title']?.[0] ?? doc.title ?? '').trim().slice(0, LIMITS.title)
  const authors = meta.citation_author ?? meta['dc.creator'] ?? []
  const date = meta.citation_publication_date?.[0] ?? meta.citation_date?.[0] ?? meta['dc.date']?.[0] ?? meta['article:published_time']?.[0] ?? null
  const kind: PageKind = doi ? 'doi' : arxiv ? 'arxiv' : isPdf ? 'pdf' : 'article'
  return { url, title, kind, doi, arxiv, pdfUrl, isPdf, authors, date, meta }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Where an article's pictures usually are; the first that holds images wins, else the whole body. */
const ARTICLE_CONTAINERS = ['article', '[itemprop="articleBody"]', 'main', '[role="main"]', '.article', '.post', '.entry-content', '#content']

/** The picture an <img> shows, by the same rule the app applies when it builds the reader view. */
export function imageSource(img: Element): string {
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

/** The article's image URLs (absolute, http/https, each once), at most `LIMITS.images`. */
export function articleImages(doc: Pick<Document, 'querySelector' | 'body'>, base: string): string[] {
  let container: Element | null = null
  for (const selector of ARTICLE_CONTAINERS) {
    const found = doc.querySelector(selector)
    if (found?.querySelector('img')) {
      container = found
      break
    }
  }
  container ??= doc.body
  const urls: string[] = []
  for (const img of Array.from(container?.querySelectorAll('img') ?? [])) {
    const url = webUrl(imageSource(img), base)
    if (url && !urls.includes(url)) urls.push(url)
    if (urls.length >= LIMITS.images) break
  }
  return urls
}

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif'

/** The raster type the bytes show (the app checks again); SVG and anything else are not sent. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (i: number, ...values: number[]): boolean => values.every((v, k) => bytes[i + k] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'avif'
  return null
}

export const isPdfBytes = (bytes: Uint8Array): boolean => bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-'

/** Base64 of bytes, in chunks (a large PDF would overflow `String.fromCharCode(...all)`). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}
