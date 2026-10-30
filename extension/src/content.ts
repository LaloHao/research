/**
 * Injected into the tab only when the user clicks the button or presses the shortcut (activeTab + scripting), in the
 * extension's isolated world: the page's scripts can't see or change it. It reads the page and, for the capture,
 * fetches the article's images (and a PDF on the page's own site) with the page's credentials, as the page itself
 * would. It never changes the page and sends nothing anywhere: it only returns what it read to the extension.
 */
import { articleImages, detect, isPdfBytes, LIMITS, sniffImage, toBase64, type Detection, type ImageType } from './detect'

export interface CollectedImage {
  url: string
  data: string
  type: ImageType
}

export interface Collected {
  html: string
  images: CollectedImage[]
}

const IMAGE_TIMEOUT_MS = 15_000
const PDF_TIMEOUT_MS = 120_000

async function fetchBytes(url: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal, referrer: location.href })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.byteLength <= maxBytes ? bytes : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function detectPage(): Detection {
  return detect(document, location.href, document.contentType)
}

async function collectPage(options: { images: boolean }): Promise<Collected> {
  const html = (document.documentElement?.outerHTML ?? '').slice(0, LIMITS.html)
  const images: CollectedImage[] = []
  if (!options.images) return { html, images }
  let total = 0
  for (const url of articleImages(document, location.href)) {
    if (total >= LIMITS.imagesTotal) break
    const bytes = await fetchBytes(url, Math.min(LIMITS.imageBytes, LIMITS.imagesTotal - total), IMAGE_TIMEOUT_MS)
    const type = bytes ? sniffImage(bytes) : null
    if (!bytes || !type) continue
    total += bytes.byteLength
    images.push({ url, data: toBase64(bytes), type })
  }
  return { html, images }
}

/** A PDF fetched from the page (same site, its cookies); null when it can't be read or is not a PDF. */
async function fetchPdf(url: string): Promise<string | null> {
  const bytes = await fetchBytes(url, LIMITS.pdfBytes, PDF_TIMEOUT_MS)
  return bytes && isPdfBytes(bytes) ? toBase64(bytes) : null
}

const api = { detectPage, collectPage, fetchPdf }
export type ConnectorPage = typeof api
;(globalThis as unknown as { __researchConnector: ConnectorPage }).__researchConnector = api
