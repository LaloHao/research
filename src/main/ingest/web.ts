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

/** Publisher landing pages carry the identifiers scholarly indexers read; use them before scraping. */
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

const EDITOR_CLAUSE = /\b(edited|reviewed|translated)\s+by\b.*$/i
const LEADING_BY = /^(written\s+by|posted\s+by|author:|by)\s+/i
const NAME_SPLIT = /\s*(?:,|\band\b|&|\sy\s|\n)\s*/i
const ORG_WORD = /\b(team|staff|editors)\b/i

/** Splits a Readability byline into authors, dropping an editor/reviewer/translator credit. */
export function parseByline(byline: string): Author[] {
  const trimmed = byline.trim()
  if (!trimmed) return []
  const withoutEditors = trimmed.replace(EDITOR_CLAUSE, '').trim()
  const withoutLeadingBy = withoutEditors.replace(LEADING_BY, '').trim()
  if (!withoutLeadingBy) return []
  return withoutLeadingBy
    .split(NAME_SPLIT)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name): Author => {
      const words = name.split(/\s+/)
      const isOrg = words.length < 2 || ORG_WORD.test(name) || name === name.toUpperCase()
      if (isOrg) return { family: name }
      return { family: words[words.length - 1], given: words.slice(0, -1).join(' ') }
    })
}

export function captureWebPage(html: string, url: string): WebCapture | null {
  const { document } = parseHTML(html)
  const article = new Readability(document as unknown as Document).parse()
  if (!article?.content || (article.textContent ?? '').trim().length < MIN_ARTICLE_CHARS) return null
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' }).turndown(article.content).trim()
  const date = article.publishedTime?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  const site = article.siteName?.trim() || new URL(url).hostname.replace(/^www\./, '')
  const authors = article.byline ? parseByline(article.byline) : []
  return {
    title: article.title?.trim() || site,
    authors,
    site,
    date,
    year: date ? Number(date.slice(0, 4)) : undefined,
    markdown
  }
}

/** The content.md of a captured page: its title, where it came from, and its readable text. */
export function webContent(capture: WebCapture, url: string): string {
  return `# ${capture.title}\n\nSource: ${url}\n\n${capture.markdown}\n`
}

export function webMetadata(capture: WebCapture, url: string): ResolvedMetadata {
  return {
    kind: 'web',
    title: capture.title,
    authors: capture.authors,
    year: capture.year,
    venue: capture.site,
    identifiers: { url },
    web: { site: capture.site, date: capture.date },
    complete: true
  }
}

/** Words a URL slug lowercases that have a fixed spelling. */
const KNOWN_CASING = new Map(
  [
    'AI', 'API', 'APIs', 'AWS', 'BERT', 'ChatGPT', 'CNN', 'CPU', 'CSS', 'CSV', 'DevOps', 'GAN', 'GANs', 'GitHub', 'GPT', 'GPU',
    'HTML', 'HTTP', 'iOS', 'IoT', 'JavaScript', 'JSON', 'LLM', 'LLMs', 'LSTM', 'ML', 'MLOps', 'NLP', 'NER', 'OpenAI', 'PDF',
    'PyTorch', 'RAG', 'REST', 'RNN', 'SaaS', 'SQL', 'TensorFlow', 'TypeScript', 'UI', 'URL', 'UX', 'XML', 'YAML'
  ].map((w) => [w.toLowerCase(), w])
)

/** Lowercase in a title unless first or last (English title case). */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'so', 'the', 'to',
  'up', 'via', 'vs', 'with', 'yet'
])

/** A trailing id such as Medium's `298978fea764` or a numeric post id. */
const TRAILING_ID = /^(?=[0-9a-f]*\d)[0-9a-f]{8,}$|^\d{5,}$/i

function titleCase(words: string[]): string {
  return words
    .map((word, i) => {
      // A word the URL already capitalized keeps its spelling.
      if (/[A-Z]/.test(word)) return word
      const known = KNOWN_CASING.get(word)
      if (known) return known
      if (i > 0 && i < words.length - 1 && MINOR_WORDS.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function slugWords(segment: string): string[] {
  let text = segment
  try {
    text = decodeURIComponent(segment)
  } catch {
    // A malformed escape keeps the segment as it is.
  }
  const words = text
    .replace(/\.(html?|php|aspx?|jsp)$/i, '')
    .split(/[-_+\s.]+/)
    .filter(Boolean)
  if (words.length > 1 && TRAILING_ID.test(words[words.length - 1])) words.pop()
  return words.some((w) => /\p{L}/u.test(w)) && !(words.length === 1 && TRAILING_ID.test(words[0])) ? words : []
}

/**
 * A title guessed from the URL of a page the app could not read: the last path segment with words (trailing id and
 * extension removed), title-cased; the site when the path has none. «how-to-validate-…-298978fea764/» → «How to Validate …».
 */
export function slugTitle(url: string): string {
  const u = new URL(url)
  const segments = u.pathname.split('/').filter(Boolean).reverse()
  for (const segment of segments) {
    const words = slugWords(segment)
    // A one- or two-letter segment (Medium's /p/) is not a title.
    if (words.join('').replace(/[^\p{L}]/gu, '').length >= 3 && !/^(index|default)$/i.test(words.join(''))) return titleCase(words)
  }
  return u.hostname.replace(/^www\./, '')
}

/** A page's own title without the site name after a separator: «Title | Towards Data Science» → «Title». */
export function cleanPageTitle(title: string): string {
  const parts = title.replace(/\s+/g, ' ').trim().split(/\s+[|–—·•]\s+|\s+-\s+/)
  const first = parts[0]?.trim() ?? ''
  return first.length >= 10 || parts.length === 1 ? first : title.replace(/\s+/g, ' ').trim()
}

/**
 * Metadata of a page whose article could not be extracted (a login wall, a page that is all script): its own title
 * (og:title or <title>) or one guessed from the URL, the site, and nothing else; marked incomplete for the user to fill in.
 */
export function bareWebMetadata(html: string | null, url: string): ResolvedMetadata {
  let title = ''
  if (html) {
    const { document } = parseHTML(html)
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? ''
    title = cleanPageTitle(og || document.querySelector('title')?.textContent || '')
  }
  const site = new URL(url).hostname.replace(/^www\./, '')
  return {
    kind: 'web',
    title: title || slugTitle(url),
    authors: [],
    venue: site,
    identifiers: { url },
    web: { site },
    complete: false
  }
}
