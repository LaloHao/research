/**
 * The requests a capture sends, from what was detected and collected (pure, tested in Node). A page with a DOI or an
 * arXiv id and no PDF goes through the app's «Agregar» flow (`capture_identifier`); anything else is sent whole
 * (`capture_page`): the app routes it the same way the in-app browser's capture does.
 */
import type { CollectedImage } from './content'
import type { Detection } from './detect'
import type { CaptureMode } from './mode'

export interface Collected {
  html: string
  images: CollectedImage[]
  /** Base64. */
  pdf: string | null
  /** «Página tal como se ve»: the page serialized in the tab, and the width it was laid out at. */
  page?: { html: string; viewportWidth: number } | null
}

/**
 * What a capture of this page has to gather in the tab. The PDF of a plain web article (no DOI, no arXiv id, no PDF
 * of its own) is made by the app from the page: its reader view, from the HTML and the article's images, or the page
 * as it looks (`mode` «page»), from the page serialized with its styles, fonts and images.
 */
export function needs(detection: Detection, mode: CaptureMode = 'reader'): { html: boolean; images: boolean; pdf: boolean; page: boolean } {
  const fromPage = printsPage(detection)
  return {
    pdf: detection.pdfUrl !== null,
    // A PDF viewer's page is not the paper; the HTML always gives the paper its readable text.
    html: !detection.isPdf,
    images: fromPage && mode === 'reader',
    page: fromPage && mode === 'page'
  }
}

/** Whether the app may print this page into its PDF (so «Vista de lectura» / «Página tal como se ve» applies). */
export function printsPage(detection: Detection): boolean {
  return !detection.isPdf && !detection.doi && !detection.arxiv
}

export type Plan = { endpoint: 'capture_identifier'; body: { identifier: string; page_url: string; title?: string } } | { endpoint: 'capture_page'; body: PageBody }

export interface PageBody {
  url: string
  final_url?: string
  title?: string
  html: string
  meta: Record<string, string[]>
  images: CollectedImage[]
  pdf?: string
  page_html?: string
  viewport_width?: number
}

export function pageBody(detection: Detection, collected: Collected): PageBody {
  const page = !detection.isPdf && !collected.pdf ? collected.page : null
  return {
    url: detection.url,
    ...(detection.title ? { title: detection.title } : {}),
    html: detection.isPdf ? '' : collected.html,
    meta: detection.meta,
    images: collected.images,
    ...(collected.pdf ? { pdf: collected.pdf } : {}),
    ...(page ? { page_html: page.html, viewport_width: page.viewportWidth } : {})
  }
}

export function planCapture(detection: Detection, collected: Collected): Plan {
  if ((detection.doi || detection.arxiv) && !collected.pdf) {
    const identifier = detection.doi ?? `arXiv:${detection.arxiv}`
    return { endpoint: 'capture_identifier', body: { identifier, page_url: detection.url, ...(detection.title ? { title: detection.title } : {}) } }
  }
  return { endpoint: 'capture_page', body: pageBody(detection, collected) }
}

export function lookupBody(detection: Detection): { url: string; doi?: string; arxiv?: string } {
  return { url: detection.url, ...(detection.doi ? { doi: detection.doi } : {}), ...(detection.arxiv ? { arxiv: detection.arxiv } : {}) }
}

/** What the popup says the page is. */
export function kindLabel(detection: Detection): string {
  switch (detection.kind) {
    case 'doi':
      return detection.pdfUrl ? 'Artículo con DOI y PDF' : 'Artículo con DOI'
    case 'arxiv':
      return 'Preprint de arXiv'
    case 'pdf':
      return 'PDF'
    default:
      return 'Artículo web'
  }
}
