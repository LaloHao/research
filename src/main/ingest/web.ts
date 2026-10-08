import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import type { Author } from '../../shared/schemas'
import { normalizeArxiv, normalizeDoi } from './identifiers'
import type { ResolvedMetadata } from './types'

export interface WebCapture {
  title: string
  authors: Author[]
  site: string
  date?: string
  year?: number
  markdown: string
}

const DOI_META = new Set(['citation_doi', 'prism.doi', 'dc.identifier', 'bepress_citation_doi'])
const MIN_ARTICLE_CHARS = 200

/** Publisher landing pages carry the identifiers Google Scholar reads; use them before scraping. */
export function findScholarlyIds(html: string): { doi?: string; arxiv?: string } {
  const { document } = parseHTML(html)
  const out: { doi?: string; arxiv?: string } = {}
  for (const meta of Array.from(document.querySelectorAll('meta'))) {
    const name = (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase()
    const content = meta.getAttribute('content')?.trim()
    if (!content) continue
    if (!out.doi && DOI_META.has(name)) {
      const doi = content.match(/10\.\d{4,9}\/\S+/)
      if (doi) out.doi = normalizeDoi(doi[0])
    }
    if (!out.arxiv && name === 'citation_arxiv_id') {
      const arxiv = normalizeArxiv(content)
      if (arxiv) out.arxiv = arxiv
    }
  }
  return out
}

export function captureWebPage(html: string, url: string): WebCapture | null {
  const { document } = parseHTML(html)
  const article = new Readability(document as unknown as Document).parse()
  if (!article?.content || (article.textContent ?? '').trim().length < MIN_ARTICLE_CHARS) return null
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' }).turndown(article.content).trim()
  const date = article.publishedTime?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  const site = article.siteName?.trim() || new URL(url).hostname.replace(/^www\./, '')
  const byline = article.byline?.trim().replace(/^by\s+/i, '')
  return {
    title: article.title?.trim() || site,
    authors: byline ? [{ family: byline }] : [],
    site,
    date,
    year: date ? Number(date.slice(0, 4)) : undefined,
    markdown
  }
}

export function webMetadata(capture: WebCapture, url: string): ResolvedMetadata {
  return {
    kind: 'web',
    title: capture.title,
    authors: capture.authors,
    year: capture.year,
    identifiers: { url },
    web: { site: capture.site, date: capture.date },
    complete: true
  }
}
