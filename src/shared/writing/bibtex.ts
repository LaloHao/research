/**
 * «BibTeX» of the writing view: a .bib with only the entries a chapter cites, and what it could not include. Pure; the
 * main process supplies the entries (the library export's, already rekeyed to each paper's key).
 */

export const BIB_ORDERS = ['appearance', 'alphabetical'] as const
export type BibOrder = (typeof BIB_ORDERS)[number]

export const BIB_FIELDS_CHECKED = ['year', 'authors', 'venue'] as const
export type BibFieldChecked = (typeof BIB_FIELDS_CHECKED)[number]

export interface BibLibraryPaper {
  title: string
  /** The entry as the library exports it (rekeyed); null when the paper's BibTeX is invalid. */
  bibtex: string | null
}

export interface ChapterBibInput {
  /** Keys cited, each once, in order of first appearance. */
  keys: string[]
  /** Library papers by key (only the cited ones are needed, plus every one for suggestions). */
  library: ReadonlyMap<string, BibLibraryPaper>
  trashed: ReadonlySet<string>
}

export interface ChapterBibReport {
  keys: string[]
  /** In order of appearance; `chapterBibText` sorts them. */
  entries: { key: string; bibtex: string }[]
  /** Cited keys the library does not have, with the closest library paper by key or title. */
  unknown: { key: string; suggestion: { key: string; title: string } | null }[]
  trashed: string[]
  incomplete: { key: string; missing: BibFieldChecked[] }[]
  /** Library papers whose BibTeX could not be read (left out, as in the library export). */
  invalid: string[]
}

/** The `name = value` fields of an entry, lowercase names, values without their braces or quotes. */
export function bibFields(entry: string): Map<string, string> {
  const fields = new Map<string, string>()
  const head = entry.indexOf(',')
  if (head < 0) return fields
  let i = head + 1
  while (i < entry.length) {
    const m = /^[\s,]*([A-Za-z][\w-]*)\s*=\s*/.exec(entry.slice(i))
    if (!m) break
    i += m[0].length
    let value = ''
    if (entry[i] === '{') {
      let depth = 0
      const start = i
      for (; i < entry.length; i++) {
        if (entry[i] === '{') depth++
        else if (entry[i] === '}' && --depth === 0) break
      }
      value = entry.slice(start + 1, i)
      i++
    } else if (entry[i] === '"') {
      const close = entry.indexOf('"', i + 1)
      value = entry.slice(i + 1, close < 0 ? entry.length : close)
      i = close < 0 ? entry.length : close + 1
    } else {
      const bare = /^[^,}\n]*/.exec(entry.slice(i))![0]
      value = bare
      i += bare.length
    }
    fields.set(m[1].toLowerCase(), value.replace(/\s+/g, ' ').trim())
  }
  return fields
}

const PRESENT: Record<BibFieldChecked, string[]> = {
  year: ['year', 'date'],
  authors: ['author', 'editor'],
  venue: ['journal', 'journaltitle', 'booktitle', 'publisher', 'school', 'institution', 'organization', 'howpublished', 'eprint', 'url']
}

/** Year, authors or venue the entry lacks (or has empty). */
export function missingFields(entry: string): BibFieldChecked[] {
  const fields = bibFields(entry)
  return BIB_FIELDS_CHECKED.filter((f) => !PRESENT[f].some((name) => (fields.get(name) ?? '') !== ''))
}

function bigrams(s: string): string[] {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return t.length < 2 ? [t] : Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))
}

/** Dice coefficient of the two strings' character bigrams (0..1). */
export function similarity(a: string, b: string): number {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.length === 0 || y.length === 0) return 0
  const pool = new Map<string, number>()
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1)
  let shared = 0
  for (const g of x) {
    const n = pool.get(g) ?? 0
    if (n > 0) {
      shared++
      pool.set(g, n - 1)
    }
  }
  return (2 * shared) / (x.length + y.length)
}

/** How well a key like `he2017drain` fits a title: its words (3+ letters) found among the title's words. */
function titleFit(key: string, title: string): number {
  const words = key.toLowerCase().match(/\p{L}{3,}/gu) ?? []
  if (words.length === 0) return 0
  const titleWords = new Set(title.toLowerCase().match(/\p{L}+/gu) ?? [])
  return words.filter((w) => titleWords.has(w)).length / words.length
}

const SUGGESTION_THRESHOLD = 0.5

/** The library paper whose key or title is closest to an unknown key, when one is close enough. */
export function suggestKey(key: string, papers: Iterable<[string, { title: string }]>): { key: string; title: string } | null {
  let best: { key: string; title: string; score: number } | null = null
  for (const [id, p] of papers) {
    const score = Math.max(similarity(key, id), 0.9 * titleFit(key, p.title))
    if (score >= SUGGESTION_THRESHOLD && (!best || score > best.score)) best = { key: id, title: p.title, score }
  }
  return best ? { key: best.key, title: best.title } : null
}

export function chapterBibReport(input: ChapterBibInput): ChapterBibReport {
  const report: ChapterBibReport = { keys: input.keys, entries: [], unknown: [], trashed: [], incomplete: [], invalid: [] }
  for (const key of input.keys) {
    const paper = input.library.get(key)
    if (!paper) {
      if (input.trashed.has(key)) report.trashed.push(key)
      else report.unknown.push({ key, suggestion: suggestKey(key, input.library) })
      continue
    }
    if (paper.bibtex === null) {
      report.invalid.push(key)
      continue
    }
    report.entries.push({ key, bibtex: paper.bibtex })
    const missing = missingFields(paper.bibtex)
    if (missing.length > 0) report.incomplete.push({ key, missing })
  }
  return report
}

export const CHAPTER_BIB_HEADER = '% Generated by the research app: only the library entries this text cites.'

/** The .bib text: the entries in order of appearance or by key. */
export function chapterBibText(report: Pick<ChapterBibReport, 'entries'>, order: BibOrder): string {
  const entries = order === 'alphabetical' ? [...report.entries].sort((a, b) => a.key.localeCompare(b.key)) : report.entries
  return `${CHAPTER_BIB_HEADER}\n\n${entries.map((e) => e.bibtex.trim()).join('\n\n')}\n`
}
