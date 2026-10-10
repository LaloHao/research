export type ParsedInput =
  | { kind: 'doi'; doi: string }
  | { kind: 'arxiv'; arxiv: string }
  | { kind: 'openalex'; openalex: string }
  | { kind: 'url'; url: string }
  | { kind: 'invalid' }

const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(?:v\d+)?$/
const ARXIV_OLD = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i
const ARXIV_IN_TEXT = /arXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i
const OPENALEX = /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d+)$/i

/** DOIs are case-insensitive; they are stored lowercase. */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;:)\]}>]+$/, '')
    .toLowerCase()
}

/** The id without its version suffix, or null when `raw` is not an arXiv id. */
export function normalizeArxiv(raw: string): string | null {
  const s = raw.trim().replace(/^arxiv:\s*/i, '')
  const m = s.match(ARXIV_NEW) ?? s.match(ARXIV_OLD)
  return m ? m[1].toLowerCase() : null
}

export function arxivDoi(id: string): string {
  return `10.48550/arxiv.${id.toLowerCase()}`
}

export function arxivFromDoi(doi: string): string | null {
  const m = doi.toLowerCase().match(/^10\.48550\/arxiv\.(.+)$/)
  return m ? m[1] : null
}

export function parseInput(input: string): ParsedInput {
  const s = input.trim()
  if (!s) return { kind: 'invalid' }
  const openalex = s.match(OPENALEX)
  if (openalex) return { kind: 'openalex', openalex: openalex[1].toUpperCase() }
  const arxiv = normalizeArxiv(s)
  if (arxiv) return { kind: 'arxiv', arxiv }
  if (/^https?:\/\//i.test(s)) {
    let url: URL
    try {
      url = new URL(s)
    } catch {
      return { kind: 'invalid' }
    }
    const path = decodeURIComponent(url.pathname)
    if (/(^|\.)doi\.org$/i.test(url.hostname)) return { kind: 'doi', doi: normalizeDoi(path.slice(1)) }
    if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
      const m = path.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/)
      const id = m ? normalizeArxiv(m[1]) : null
      if (id) return { kind: 'arxiv', arxiv: id }
    }
    const doi = path.match(DOI_IN_TEXT)
    if (doi) return { kind: 'doi', doi: normalizeDoi(doi[1]) }
    return { kind: 'url', url: s }
  }
  const doi = s.match(/^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i)
  if (doi) return { kind: 'doi', doi: normalizeDoi(doi[1]) }
  return { kind: 'invalid' }
}

export function findIdentifiersInText(text: string): { doi?: string; arxiv?: string } {
  const out: { doi?: string; arxiv?: string } = {}
  const doi = text.match(DOI_IN_TEXT)
  if (doi) out.doi = normalizeDoi(doi[1])
  const arxiv = text.match(ARXIV_IN_TEXT)
  if (arxiv) out.arxiv = arxiv[1]
  return out
}
