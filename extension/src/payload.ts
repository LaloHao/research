/**
 * The requests a capture sends, from what was detected and collected (pure, tested in Node). A page with a DOI or an
 * arXiv id and no PDF goes through the app's «Agregar» flow (`capture_identifier`); anything else is sent whole
 * (`capture_page`): the app routes it the same way the in-app browser's capture does.
 */
import type { CollectedImage } from './content'
import type { Detection } from './detect'

export interface Collected {
  html: string
  images: CollectedImage[]
  /** Base64. */
  pdf: string | null
}

/** What a capture of this page has to gather in the tab. */
export function needs(detection: Detection): { html: boolean; images: boolean; pdf: boolean } {
  const identified = Boolean(detection.doi || detection.arxiv)
  return {
    pdf: detection.pdfUrl !== null,
    // A PDF viewer's page is not the paper.
    html: !detection.isPdf,
    // Images are only needed for the reader-view PDF of a plain web article.
    images: !detection.isPdf && !identified
  }
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
}

export function pageBody(detection: Detection, collected: Collected): PageBody {
  return {
    url: detection.url,
    ...(detection.title ? { title: detection.title } : {}),
    html: detection.isPdf ? '' : collected.html,
    meta: detection.meta,
    images: collected.images,
    ...(collected.pdf ? { pdf: collected.pdf } : {})
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
