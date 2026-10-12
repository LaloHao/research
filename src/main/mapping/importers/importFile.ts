import { extname } from 'node:path'
import type { ImportFormat, RecordIdentifiers, WorkCandidate } from '../../../shared/mapping'
import type { Author, PaperKind } from '../../../shared/schemas'
import { arxivFromDoi, normalizeArxiv, normalizeDoi, parseInput, type ParsedInput } from '../../ingest/identifiers'
import { latexToText, parseBibtex, splitBibNames, type BibEntry } from './bibtex'
import { parseCsv } from './csv'
import { MAX_AUTHORS, MAX_NAME_LENGTH, parseName, parseNames, splitAuthors } from './names'
import { parseRis } from './ris'

/** The largest export the app reads (bytes on disk; also the longest text `parseExport` accepts). */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024
/** Entries read from one export at most; the rest are left out and `truncated` is set. */
export const MAX_EXPORT_RECORDS = 50_000
/** Longer values are cut (a broken export can put a whole file in one field). */
export const MAX_TITLE_LENGTH = 1000
export const MAX_ABSTRACT_LENGTH = 20_000
export const MAX_VENUE_LENGTH = 500

export interface ParsedExport {
  format: ImportFormat
  records: WorkCandidate[]
  /** Entries without a title. */
  skipped: number
  /** Set when the file had more than MAX_EXPORT_RECORDS entries and only the first ones were read. */
  truncated?: true
}

type Family = 'bibtex' | 'ris' | 'csv'

/**
 * The text of an export file: UTF-8 with or without BOM, UTF-16 (by its BOM, or by the zero bytes of mostly-ASCII
 * text), and anything that is not valid UTF-8 read as Windows-1252 (old Latin-1 exports). Never throws.
 */
export function decodeExport(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2))
  const utf16 = guessUtf16(bytes)
  if (utf16 === 'le') return new TextDecoder('utf-16le').decode(bytes)
  if (utf16 === 'be') return utf16be(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return windows1252(bytes)
  }
}

function utf16be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]
    swapped[i + 1] = bytes[i]
  }
  return new TextDecoder('utf-16le').decode(swapped)
}

/** UTF-16 without a BOM shows as a zero byte in every other position of ASCII text. */
function guessUtf16(bytes: Uint8Array): 'le' | 'be' | null {
  const pairs = Math.min(bytes.length, 4096) >> 1
  if (pairs < 2) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let p = 0; p < pairs; p++) {
    if (bytes[2 * p] === 0) evenZeros++
    if (bytes[2 * p + 1] === 0) oddZeros++
  }
  if (oddZeros > pairs * 0.4 && evenZeros < pairs * 0.05) return 'le'
  if (evenZeros > pairs * 0.4 && oddZeros < pairs * 0.05) return 'be'
  return null
}

function windows1252(bytes: Uint8Array): string {
  try {
    return new TextDecoder('windows-1252').decode(bytes)
  } catch {
    let out = ''
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return out
  }
}

/** By extension first; a .txt (or no extension) by its first lines. */
export function detectFormat(fileName: string, text: string): Family | null {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.bib' || ext === '.bibtex') return 'bibtex'
  if (ext === '.ris') return 'ris'
  if (ext === '.csv') return 'csv'
  const head = text.replace(/^\uFEFF/, '').slice(0, 4000)
  if (/^[ \t]*@[ \t]*[A-Za-z]+[ \t]*[{(]/m.test(head)) return 'bibtex'
  if (/^TY {2}- /m.test(head)) return 'ris'
  return null
}

/**
 * The records of an export file; null when it is not BibTeX, RIS or CSV, is binary, or is longer than
 * MAX_EXPORT_BYTES. Never throws: every parser is linear in its input and bounds what it keeps.
 */
export function parseExport(fileName: string, text: string): ParsedExport | null {
  if (text.length > MAX_EXPORT_BYTES || text.slice(0, 4000).includes('\u0000')) return null
  try {
    return readExport(fileName, text)
  } catch {
    return null
  }
}

function readExport(fileName: string, text: string): ParsedExport | null {
  switch (detectFormat(fileName, text)) {
    case 'bibtex': {
      const entries = parseBibtex(text, MAX_EXPORT_RECORDS + 1)
      return collect('bibtex', entries.slice(0, MAX_EXPORT_RECORDS).map(fromBib), entries.length > MAX_EXPORT_RECORDS)
    }
    case 'ris': {
      const entries = parseRis(text, MAX_EXPORT_RECORDS + 1)
      return collect('ris', entries.slice(0, MAX_EXPORT_RECORDS).map(fromRis), entries.length > MAX_EXPORT_RECORDS)
    }
    case 'csv':
      return fromCsv(text)
    default:
      return null
  }
}

function collect(format: ImportFormat, items: (WorkCandidate | null)[], truncated: boolean): ParsedExport {
  const records = items.filter((x): x is WorkCandidate => x !== null)
  return { format, records, skipped: items.length - records.length, ...(truncated ? { truncated: true as const } : {}) }
}

const YEAR = /\b(1[5-9]\d\d|2\d\d\d)\b/
const NO_ABSTRACT = /^\[no abstract available\]$/i
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function firstYear(s: string | null | undefined): number | null {
  const m = s ? YEAR.exec(s.slice(0, 200)) : null
  return m ? Number(m[1]) : null
}

/** Whitespace collapsed, control characters dropped, cut at `max`; null when nothing is left. */
function clean(s: string | null | undefined, max = MAX_TITLE_LENGTH): string | null {
  if (!s) return null
  // Whitespace runs are collapsed before cutting, so a long run of blanks never hides the text after it.
  const v = s
    .slice(0, Math.max(max * 4, 100_000))
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
  return v ? v : null
}

const abstractOf = (s: string | null): string | null => (s && !NO_ABSTRACT.test(s) ? s : null)

const DOI = /^10\.\d{4,9}\/\S+$/

function doiOf(raw: string): string | null {
  const doi = normalizeDoi(raw.slice(0, 500))
  return DOI.test(doi) ? doi : null
}

function linkOf(url: string): ParsedInput | null {
  try {
    return parseInput(url.slice(0, 2000))
  } catch {
    return null // a malformed percent-escape in the link
  }
}

/** A DOI from its field or from a doi.org/arXiv link, and an arXiv id from its field, its link or an arXiv DOI. */
function identifiers(doiField: string | null, extra: { arxiv?: string | null; url?: string | null } = {}): RecordIdentifiers {
  const link = extra.url ? linkOf(extra.url) : null
  const doi = (doiField ? doiOf(doiField) : null) ?? (link?.kind === 'doi' && DOI.test(link.doi) ? link.doi : null)
  const arxiv =
    (extra.arxiv ? normalizeArxiv(extra.arxiv.slice(0, 100)) : null) ?? (link?.kind === 'arxiv' ? link.arxiv : null) ?? (doi ? arxivFromDoi(doi) : null)
  return { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}) }
}

const BIB_KINDS: Record<string, PaperKind> = {
  article: 'article',
  inproceedings: 'conference',
  conference: 'conference',
  proceedings: 'conference',
  book: 'book',
  incollection: 'chapter',
  inbook: 'chapter',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  online: 'web'
}

function bibName(raw: string): Author[] {
  const s = raw.trim().slice(0, MAX_NAME_LENGTH * 2)
  if (/^\{[^{}]*(\{[^{}]*\}[^{}]*)*\}$/.test(s)) {
    const family = clean(latexToText(s), MAX_NAME_LENGTH)
    return family ? [{ family }] : []
  }
  const author = parseName(latexToText(s))
  return author ? [author] : []
}

function fromBib(e: BibEntry): WorkCandidate | null {
  const raw = (name: string): string | undefined => (Object.hasOwn(e.fields, name) ? e.fields[name] : undefined)
  const field = (name: string, max = MAX_TITLE_LENGTH): string | null => {
    const value = raw(name)
    // Values are already bounded by the parser (MAX_BIB_VALUE) and latexToText is linear.
    return value === undefined ? null : clean(latexToText(value), max)
  }
  const title = field('title')
  if (!title) return null
  const archive = raw('archiveprefix') ?? raw('eprinttype') ?? ''
  const ids = identifiers(field('doi'), { arxiv: /arxiv/i.test(archive.slice(0, 100)) ? field('eprint') : null, url: field('url', 2000) })
  const names = splitBibNames((raw('author') ?? raw('editor') ?? '').slice(0, MAX_AUTHORS * MAX_NAME_LENGTH))
  return {
    title,
    authors: names.flatMap(bibName).slice(0, MAX_AUTHORS),
    year: firstYear(raw('year') ?? raw('date')),
    venue: ['journal', 'journaltitle', 'booktitle', 'school', 'institution'].reduce<string | null>((found, name) => found ?? field(name, MAX_VENUE_LENGTH), null),
    abstract: field('abstract', MAX_ABSTRACT_LENGTH),
    kind: (Object.hasOwn(BIB_KINDS, e.type) ? BIB_KINDS[e.type] : null) ?? (ids.arxiv ? 'preprint' : 'other'),
    identifiers: ids
  }
}

const RIS_KINDS: Record<string, PaperKind> = {
  JOUR: 'article',
  JFULL: 'article',
  MGZN: 'article',
  CONF: 'conference',
  CPAPER: 'conference',
  BOOK: 'book',
  EBOOK: 'book',
  CHAP: 'chapter',
  ECHAP: 'chapter',
  THES: 'thesis',
  RPRT: 'report',
  ELEC: 'web',
  BLOG: 'web'
}

function fromRis(e: Record<string, string[]>): WorkCandidate | null {
  const one = (tags: string[], max = MAX_TITLE_LENGTH): string | null => {
    for (const tag of tags) {
      const value = clean(e[tag]?.[0], max)
      if (value) return value
    }
    return null
  }
  const title = one(['TI', 'T1', 'CT'])
  if (!title) return null
  const type = one(['TY']) ?? ''
  return {
    title,
    authors: parseNames([...(e.AU ?? []), ...(e.A1 ?? [])]),
    year: firstYear(one(['PY', 'Y1', 'DA'])),
    venue: one(['T2', 'JO', 'JF', 'SO', 'BT', 'T3'], MAX_VENUE_LENGTH),
    abstract: one(['AB', 'N2'], MAX_ABSTRACT_LENGTH),
    kind: Object.hasOwn(RIS_KINDS, type) ? RIS_KINDS[type] : 'other',
    identifiers: identifiers(one(['DO']), { url: one(['UR'], 2000) })
  }
}

/** `="…"`, the way some tools keep a spreadsheet from reading a cell as a number or a formula. */
const EXCEL_TEXT = /^="([\s\S]*)"$/

/** The first non-empty value among these columns, matched ignoring case. */
function pick(row: Record<string, string>, names: string[], max = MAX_TITLE_LENGTH): string | null {
  const keys = Object.keys(row)
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase() === name.toLowerCase())
    if (key === undefined) continue
    const cell = row[key]
    const guarded = EXCEL_TEXT.exec(cell.slice(0, max * 2 + 3))
    const value = clean(guarded ? guarded[1].replace(/""/g, '"') : cell, max)
    if (value) return value
  }
  return null
}

function csvKind(value: string | null): PaperKind | null {
  if (!value) return null
  const v = value.toLowerCase()
  if (v.includes('conference') || v.includes('proceeding')) return 'conference'
  if (v.includes('chapter')) return 'chapter'
  if (v.includes('book')) return 'book'
  if (v.includes('journal') || v.includes('article') || v.includes('review') || v.includes('magazine')) return 'article'
  return 'other'
}

const AUTHOR_LIST = MAX_AUTHORS * MAX_NAME_LENGTH

/** Scopus: «Author full names» when exported; otherwise the short names, `;`-separated (newer) or `,`-separated after initials (older). */
function scopusAuthors(row: Record<string, string>): Author[] {
  const full = pick(row, ['Author full names'], AUTHOR_LIST)
  if (full) return splitAuthors(full, /;/)
  const short = pick(row, ['Authors'], AUTHOR_LIST) ?? ''
  return splitAuthors(short, short.includes(';') ? /;/ : /(?<=\.),\s*/)
}

function csvRecord(format: ImportFormat, row: Record<string, string>): WorkCandidate | null {
  const title = pick(row, ['Title', 'Document Title', 'Article Title', 'Título', 'Titulo'])
  if (!title) return null
  return {
    title,
    authors: format === 'csv_scopus' ? scopusAuthors(row) : splitAuthors(pick(row, ['Authors', 'Author', 'Autores'], AUTHOR_LIST) ?? '', /;/),
    year: firstYear(pick(row, ['Year', 'Publication Year', 'Publication_Year', 'Año'])),
    venue: pick(row, ['Source title', 'Publication Title', 'Venue', 'Journal', 'Source'], MAX_VENUE_LENGTH),
    abstract: abstractOf(pick(row, ['Abstract', 'Resumen'], MAX_ABSTRACT_LENGTH)),
    kind: csvKind(pick(row, ['Document Type', 'Document Identifier', 'Type'])),
    identifiers: identifiers(pick(row, ['DOI']), { arxiv: pick(row, ['arXiv', 'arxiv_id']), url: pick(row, ['Link', 'PDF Link', 'URL'], 2000) })
  }
}

function fromCsv(text: string): ParsedExport {
  const { header, rows, truncated } = parseCsv(text, { maxRows: MAX_EXPORT_RECORDS })
  const has = (name: string): boolean => header.some((h) => h.toLowerCase() === name.toLowerCase())
  const format: ImportFormat = has('Source title') && has('Title') ? 'csv_scopus' : has('Document Title') && has('Publication Year') ? 'csv_ieee' : 'csv'
  return collect(
    format,
    rows.map((row) => csvRecord(format, row)),
    truncated === true
  )
}
