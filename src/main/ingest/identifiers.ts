export type ParsedInput =
  | { kind: 'doi'; doi: string }
  | { kind: 'arxiv'; arxiv: string }
  | { kind: 'openalex'; openalex: string }
  | { kind: 'isbn'; isbn: string }
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

/** ISBN-13 check digit of its first 12 digits. */
function isbn13CheckDigit(first12: string): string {
  const sum = [...first12].reduce((acc, c, i) => acc + Number(c) * (i % 2 ? 3 : 1), 0)
  return String((10 - (sum % 10)) % 10)
}

/**
 * The ISBN-13 (digits only) of an ISBN-10 or ISBN-13, with or without hyphens, spaces or an «ISBN» prefix; null when
 * it is not one or its check digit is wrong. An ISBN-10 becomes its 978 ISBN-13, so both forms of a book are equal.
 */
export function normalizeIsbn(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^isbn(?:-?1[03])?:?\s*/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0)
    if (sum % 11 !== 0) return null
    const first12 = `978${s.slice(0, 9)}`
    return first12 + isbn13CheckDigit(first12)
  }
  if (/^97[89]\d{10}$/.test(s)) return isbn13CheckDigit(s.slice(0, 12)) === s[12] ? s : null
  return null
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
  const isbn = normalizeIsbn(s)
  if (isbn) return { kind: 'isbn', isbn }
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

/** «ISBN 978-1-4919-2912-4», «ISBN-10: 149192912X», «ISBN: 978 1 4919 2912 4» in a text (a book's copyright page). */
const ISBN_IN_TEXT = /\bISBN(?:-?1[03])?\s*(?:\([^)]{0,20}\))?\s*:?\s*((?:\d[\s\u2010-\u2013-]?){9}[\dXx](?:[\s\u2010-\u2013-]?\d){0,3})/g

/** The first valid ISBN (as its ISBN-13) in TEXT, or undefined. */
export function findIsbnInText(text: string): string | undefined {
  for (const m of text.matchAll(ISBN_IN_TEXT)) {
    const isbn = normalizeIsbn(m[1].replace(/[\u2010-\u2013]/g, '-'))
    if (isbn) return isbn
  }
  return undefined
}

export function findIdentifiersInText(text: string): { doi?: string; arxiv?: string } {
  const out: { doi?: string; arxiv?: string } = {}
  const doi = text.match(DOI_IN_TEXT)
  if (doi) out.doi = normalizeDoi(doi[1])
  const arxiv = text.match(ARXIV_IN_TEXT)
  if (arxiv) out.arxiv = arxiv[1]
  return out
}
