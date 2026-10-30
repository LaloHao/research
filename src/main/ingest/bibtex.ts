import type { Author, PaperKind } from '../../shared/schemas'

const HEAD = /^\s*@(\w+)\s*\{\s*([^,\s]*)\s*,/

export function rekeyBibtex(entry: string, key: string): string {
  const m = entry.match(HEAD)
  if (!m) throw new Error('Not a BibTeX entry')
  return normalizeBibMonth(entry.replace(HEAD, () => `@${m[1]}{${key},`).trim())
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// English and Spanish month names and their common abbreviations (Crossref writes `month=June`, `month=Oct`).
const MONTH_NAMES: Record<string, number> = Object.fromEntries(
  [
    ['january', 'jan', 'enero', 'ene'],
    ['february', 'feb', 'febrero'],
    ['march', 'mar', 'marzo'],
    ['april', 'apr', 'abril', 'abr'],
    ['may', 'mayo'],
    ['june', 'jun', 'junio'],
    ['july', 'jul', 'julio'],
    ['august', 'aug', 'agosto', 'ago'],
    ['september', 'sep', 'sept', 'septiembre', 'setiembre', 'set'],
    ['october', 'oct', 'octubre'],
    ['november', 'nov', 'noviembre'],
    ['december', 'dec', 'diciembre', 'dic']
  ].flatMap((names, i) => names.map((n) => [n, i + 1]))
)

const MONTH_FIELD = /(\bmonth\s*=\s*)(\{\s*([^{}]*?)\s*\}|"\s*([^"]*?)\s*"|([A-Za-z]+\.?|\d+))/i

/**
 * `month` as BibTeX/biblatex expect it: the standard macro (`jun`), unbraced, for a month name or abbreviation in
 * English or Spanish, in any case, braced, quoted or bare (`June`, `{Oct}`, `"sept."`); a number 1–12 becomes its
 * macro too. Anything else (a range, a season) is left as it was.
 */
export function normalizeBibMonth(entry: string): string {
  return entry.replace(MONTH_FIELD, (whole, lead: string, _v, braced?: string, quoted?: string, bare?: string) => {
    const raw = (braced ?? quoted ?? bare ?? '').trim().replace(/\.$/, '').toLowerCase()
    const n = /^\d+$/.test(raw) ? Number(raw) : MONTH_NAMES[raw]
    return n && n >= 1 && n <= 12 ? `${lead}${MONTHS[n - 1]}` : whole
  })
}

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}'
}

/** Accented letters stay as UTF-8 (biber and modern bibtex setups read it). */
export function escapeLatex(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) => SPECIAL[c])
}

/** `family`-only names (organizations, bylines) are braced so BibTeX does not split them. */
export function formatAuthors(authors: Author[]): string {
  return authors
    .map((a) => (a.given ? `${escapeLatex(a.family)}, ${escapeLatex(a.given)}` : `{${escapeLatex(a.family)}}`))
    .join(' and ')
}

export type BibField = [name: string, value: string | number | undefined, raw?: boolean]

export function buildEntry(type: string, key: string, fields: BibField[]): string {
  const lines = fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value, raw]) => `  ${name} = {${raw ? String(value) : escapeLatex(String(value))}}`)
  return `@${type}{${key},\n${lines.join(',\n')}\n}`
}

export function buildOnlineEntry(p: {
  key: string
  title: string
  authors: Author[]
  site?: string
  date?: string
  year?: number
  url: string
  urldate: string
}): string {
  return buildEntry('online', p.key, [
    ['author', p.authors.length ? formatAuthors(p.authors) : undefined, true],
    ['title', p.title],
    ['organization', p.site],
    ['date', p.date, true],
    ['year', p.date ? undefined : p.year],
    ['url', p.url, true],
    ['urldate', p.urldate, true]
  ])
}

const TYPE_BY_KIND: Record<PaperKind, string> = {
  article: 'article',
  conference: 'inproceedings',
  preprint: 'misc',
  book: 'book',
  chapter: 'incollection',
  thesis: 'thesis',
  report: 'techreport',
  web: 'online',
  other: 'misc'
}

const VENUE_FIELD: Partial<Record<PaperKind, string>> = {
  article: 'journal',
  conference: 'booktitle',
  chapter: 'booktitle',
  report: 'institution'
}

/** Used only when no publisher BibTeX exists (e.g. a PDF without DOI). */
export function buildFallbackEntry(p: {
  key: string
  kind: PaperKind
  title: string
  authors: Author[]
  year?: number
  venue?: string
  doi?: string
  arxiv?: string
  url?: string
}): string {
  const venueField = VENUE_FIELD[p.kind]
  return buildEntry(TYPE_BY_KIND[p.kind], p.key, [
    ['author', p.authors.length ? formatAuthors(p.authors) : undefined, true],
    ['title', p.title],
    ['year', p.year],
    ...(venueField ? [[venueField, p.venue] as BibField] : []),
    ['doi', p.doi, true],
    ['eprint', p.arxiv, true],
    ['archiveprefix', p.arxiv ? 'arXiv' : undefined, true],
    ['url', p.url, true]
  ])
}

interface RawField {
  name: string
  /** The value as written: `{…}`, `"…"`, a bare word, or a `#` concatenation of them. */
  value: string
}

/** Reads one value token at `i`: braced, quoted or bare; returns its end. */
function valueEnd(entry: string, i: number): number {
  if (entry[i] === '{') {
    let depth = 0
    for (let j = i; j < entry.length; j++) {
      if (entry[j] === '{') depth++
      else if (entry[j] === '}' && --depth === 0) return j + 1
    }
    return entry.length
  }
  if (entry[i] === '"') {
    let depth = 0
    for (let j = i + 1; j < entry.length; j++) {
      if (entry[j] === '{') depth++
      else if (entry[j] === '}') depth--
      else if (entry[j] === '"' && depth === 0) return j + 1
    }
    return entry.length
  }
  const bare = /^[^,}#\s]*/.exec(entry.slice(i))![0]
  return i + bare.length
}

/** The head (`@type{key`) and the fields of an entry, values as written; null when it is not an entry. */
function parseRawEntry(entry: string): { type: string; key: string; fields: RawField[] } | null {
  const head = entry.match(HEAD)
  if (!head) return null
  const fields: RawField[] = []
  let i = head[0].length
  for (;;) {
    const m = /^[\s,]*([A-Za-z][\w:-]*)\s*=\s*/.exec(entry.slice(i))
    if (!m) break
    i += m[0].length
    const start = i
    for (;;) {
      i = valueEnd(entry, i)
      const more = /^\s*#\s*/.exec(entry.slice(i))
      if (!more) break
      i += more[0].length
    }
    fields.push({ name: m[1], value: entry.slice(start, i).trim() })
  }
  return { type: head[1], key: head[2], fields }
}

/**
 * The entry with these fields set (a braced value; `raw` values are not escaped) or removed (null). Every other
 * field keeps its value as written and the key never changes; the entry comes back one field per line. Field names
 * match case-insensitively. Throws when `entry` is not a BibTeX entry.
 */
export function setBibFields(entry: string, changes: Record<string, { value: string; raw?: boolean } | null>): string {
  const parsed = parseRawEntry(entry)
  if (!parsed) throw new Error('Not a BibTeX entry')
  const pending = new Map(Object.entries(changes).map(([name, change]) => [name.toLowerCase(), change]))
  const braced = (c: { value: string; raw?: boolean }): string => `{${c.raw ? c.value : escapeLatex(c.value)}}`
  const lines: string[] = []
  for (const field of parsed.fields) {
    const name = field.name.toLowerCase()
    if (!pending.has(name)) {
      lines.push(`  ${field.name} = ${field.value}`)
      continue
    }
    const change = pending.get(name)!
    pending.delete(name)
    if (change) lines.push(`  ${field.name} = ${braced(change)}`)
  }
  for (const [name, change] of pending) if (change) lines.push(`  ${name} = ${braced(change)}`)
  return `@${parsed.type}{${parsed.key},\n${lines.join(',\n')}\n}`
}

/** The entry's type, lowercase (`article`, `online`, …); null when it is not an entry. */
export function bibType(entry: string): string | null {
  return entry.match(HEAD)?.[1].toLowerCase() ?? null
}
