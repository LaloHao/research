/**
 * Citations in the user's own writing: LaTeX (natbib and biblatex commands), Markdown (pandoc) and Org (org-cite). Pure:
 * the renderer, the main process and any later API share it. Offsets always refer to the text as given.
 */

export const CITE_FORMATS = ['org', 'latex', 'markdown'] as const
export type CiteFormat = (typeof CITE_FORMATS)[number]

/** The natbib and biblatex commands recognized (with or without `*`, and their capitalized forms). */
export const LATEX_CITE_COMMANDS = [
  'cite',
  'citep',
  'citet',
  'citealp',
  'citealt',
  'citeauthor',
  'citeyear',
  'citeyearpar',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'fullcite',
  'smartcite',
  'supercite',
  'nocite',
  'Cite',
  'Citep',
  'Citet',
  'Citealp',
  'Citeauthor',
  'Parencite',
  'Textcite',
  'Autocite',
  'Footcite',
  'Smartcite'
] as const

export interface CitationItem {
  key: string
  /** Text before the key (pandoc/org prefix, or a LaTeX prenote). */
  prefix: string | null
  /** The locator as written (`p.~3`, `p. 3`, `pp. 3-5`, `cap. 2`). */
  locator: string | null
  /** The page or page range the locator names (`3`, `3-5`), when it names one. */
  page: string | null
}

export interface Citation {
  /** Every key cited, in order (a key repeated inside the citation stays repeated). */
  keys: string[]
  items: CitationItem[]
  /** `cite`, `citep*`, `parencite`… for LaTeX; `pandoc` (`[@a]`), `pandoc_bare` (`@a`) for Markdown; `cite`, `cite/t`… for Org. */
  command: string
  syntax: 'latex' | 'pandoc' | 'org'
  /** Offsets of the whole citation in the text. */
  start: number
  end: number
  /** The citation's locator: the LaTeX postnote, or the first item's locator. */
  locator: string | null
  page: string | null
  /** The sentence that contains the citation, whitespace collapsed. */
  sentence: Sentence
}

export interface Sentence {
  start: number
  end: number
  text: string
}

// ---------------------------------------------------------------------------------------------------------------------
// Format detection

/** The likeliest format of a text: whichever syntax has the most telltale marks; Markdown when there are none. */
export function detectFormat(text: string): CiteFormat {
  const count = (re: RegExp): number => text.match(re)?.length ?? 0
  const org =
    3 * count(/\[cite(?:\/[\w/-]+)?:/g) + 2 * count(/^#\+(?:title|author|begin_\w+|include|bibliography|cite_export|options|latex_class)\b/gim) + count(/^\*+ \S/gm)
  const latex =
    3 * count(new RegExp(`\\\\(?:${LATEX_CITE_COMMANDS.join('|')})\\*?(?![A-Za-z])`, 'g')) +
    2 * count(/\\(?:begin|end|section|subsection|chapter|documentclass|usepackage|input|include|label|ref)\b/g)
  const markdown = 3 * count(/\[[^\]\n]*-?@[\p{L}\p{N}_]/gu) + count(/^#{1,6} \S/gm) + count(/^```/gm)
  if (org === 0 && latex === 0 && markdown === 0) return 'markdown'
  if (org >= latex && org >= markdown) return 'org'
  return latex >= markdown ? 'latex' : 'markdown'
}

// ---------------------------------------------------------------------------------------------------------------------
// Masking: comments, verbatim and code are blanked out (offsets and newlines kept) before anything is searched.

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' '
}

const VERBATIM_ENVS = ['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim', 'alltt']

/** Whether the character at `i` is escaped by an odd run of backslashes before it. */
function escaped(text: string, i: number): boolean {
  let n = 0
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++
  return n % 2 === 1
}

/** LaTeX: unescaped `%` comments, the verbatim environments and `\verb|…|` blanked out. */
export function maskLatex(text: string): string {
  // UTF-16 units, so offsets stay those of the text even with characters outside the BMP.
  const units = text.split('')
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '%' && !escaped(text, i)) {
      const eol = text.indexOf('\n', i)
      const end = eol < 0 ? text.length : eol
      blank(units, i, end)
      i = end
      continue
    }
    if (c === '\\' && !escaped(text, i)) {
      const begin = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(text.slice(i, i + 40))
      if (begin && VERBATIM_ENVS.includes(begin[1])) {
        const close = text.indexOf(`\\end{${begin[1]}}`, i + begin[0].length)
        const end = close < 0 ? text.length : close + `\\end{${begin[1]}}`.length
        blank(units, i, end)
        i = end
        continue
      }
      const verb = /^\\(?:verb\*?|lstinline)([^A-Za-z\s{[])/.exec(text.slice(i, i + 12))
      if (verb) {
        const close = text.indexOf(verb[1], i + verb[0].length)
        const eol = text.indexOf('\n', i)
        const end = close < 0 || (eol >= 0 && close > eol) ? (eol < 0 ? text.length : eol) : close + 1
        blank(units, i, end)
        i = end
        continue
      }
      i += 2
      continue
    }
    i++
  }
  return units.join('')
}

/** Markdown: fenced code blocks, inline code and HTML comments blanked out. */
export function maskMarkdown(text: string): string {
  const units = text.split('')
  for (const m of text.matchAll(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm)) blank(units, m.index, m.index + m[0].length)
  const fenced = units.join('')
  for (const m of fenced.matchAll(/(`+)(?!`)(?:[^\n]|\n(?![ \t]*\n))*?[^`]\1(?!`)|<!--[\s\S]*?(?:-->|$)/g)) blank(units, m.index, m.index + m[0].length)
  return units.join('')
}

/** Org: comment lines (`# …`), and source, example, export and comment blocks blanked out. */
export function maskOrg(text: string): string {
  const units = text.split('')
  for (const m of text.matchAll(/^[ \t]*#\+begin_(src|example|export|comment)\b[^\n]*\n?[\s\S]*?(?:^[ \t]*#\+end_\1\b[^\n]*|(?![\s\S]))/gim))
    blank(units, m.index, m.index + m[0].length)
  for (const m of text.matchAll(/^[ \t]*#(?: [^\n]*)?$/gm)) blank(units, m.index, m.index + m[0].length)
  return units.join('')
}

export function maskText(text: string, format: CiteFormat): string {
  if (format === 'latex') return maskLatex(text)
  if (format === 'org') return maskOrg(text)
  return maskMarkdown(text)
}

// ---------------------------------------------------------------------------------------------------------------------
// Locators

const PAGE_LOCATOR = /^(?:pp?\.|pages?|págs?\.|pág\.|s\.)\s*~?\s*(\d+(?:\s*(?:--?|–|—)\s*\d+)?)(?![\d])/i

/** The page or page range a locator names (`p.~3` → `3`, `pp. 3--5` → `3-5`, `12` → `12`); null for other locators. */
export function pageOf(locator: string | null): string | null {
  if (!locator) return null
  const s = locator.replace(/\\,|\\ |~/g, ' ').trim()
  const m = PAGE_LOCATOR.exec(s) ?? /^(\d+(?:\s*(?:--?|–|—)\s*\d+)?)$/.exec(s)
  if (!m) return null
  return m[1].replace(/\s*(?:--?|–|—)\s*/, '-')
}

const clean = (s: string | undefined): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? t : null
}

// ---------------------------------------------------------------------------------------------------------------------
// The three syntaxes

type RawCitation = Omit<Citation, 'sentence'>

const LATEX_CITE = new RegExp(
  `\\\\(${LATEX_CITE_COMMANDS.join('|')})(?![A-Za-z])(\\*?)((?:\\s*\\[[^\\]\\n]*\\]){0,2})\\s*\\{([^{}]*)\\}`,
  'g'
)

function latexCitations(masked: string): RawCitation[] {
  const out: RawCitation[] = []
  for (const m of masked.matchAll(LATEX_CITE)) {
    const optional = [...m[3].matchAll(/\[([^\]\n]*)\]/g)].map((o) => o[1])
    // natbib/biblatex: one optional argument is the postnote; two are prenote and postnote.
    const [prenote, postnote] = optional.length === 2 ? optional : [undefined, optional[0]]
    const keys = m[4]
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '' && k !== '*')
    if (keys.length === 0) continue
    const locator = clean(postnote)
    const page = pageOf(locator)
    out.push({
      keys,
      items: keys.map((key, i) => ({ key, prefix: i === 0 ? clean(prenote) : null, locator: i === keys.length - 1 ? locator : null, page: i === keys.length - 1 ? page : null })),
      command: m[1] + m[2],
      syntax: 'latex',
      start: m.index,
      end: m.index + m[0].length,
      locator,
      page
    })
  }
  return out
}

/** A pandoc key: starts with a letter, digit or `_`; inner punctuation only when a word character follows it. */
const PANDOC_KEY = String.raw`(?:\{([^{}\n]+)\}|([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&+?<>~/-](?=[\p{L}\p{N}_]))*))`

/** One `prefix @key suffix` item of a bracketed pandoc or org citation; null when it has no key. */
function bracketItem(part: string): CitationItem | null {
  const m = new RegExp(`(^|[^\\p{L}\\p{N}_.%+-])-?@${PANDOC_KEY}`, 'u').exec(part)
  if (!m) return null
  const key = m[2] ?? m[3]
  const prefix = clean(part.slice(0, m.index + m[1].length))
  const locator = clean(part.slice(m.index + m[0].length).replace(/^\s*,/, ''))
  return { key, prefix, locator, page: pageOf(locator) }
}

function fromItems(items: CitationItem[], command: string, syntax: 'pandoc' | 'org', start: number, end: number): RawCitation {
  const first = items.find((i) => i.locator !== null) ?? null
  return { keys: items.map((i) => i.key), items, command, syntax, start, end, locator: first?.locator ?? null, page: first?.page ?? null }
}

function pandocCitations(masked: string): RawCitation[] {
  const out: RawCitation[] = []
  const taken = masked.split('')
  // `[see @a, p. 3; @b]`: every `;`-separated part must hold a key, or the brackets are something else (a link…).
  for (const m of masked.matchAll(/\[([^[\]\n]*@[^[\]\n]*)\](?!\(|\[|:)/g)) {
    const parts = m[1].split(';')
    const items = parts.map(bracketItem)
    if (items.some((i) => i === null)) continue
    out.push(fromItems(items as CitationItem[], 'pandoc', 'pandoc', m.index, m.index + m[0].length))
    blank(taken, m.index, m.index + m[0].length)
  }
  // `@key` in the running text, optionally with `[p. 3]` right after: never an email (`me@uni.edu`) or inside a word.
  const bare = new RegExp(`(^|[^\\p{L}\\p{N}_.%+\\-@\\\\/:=])(-?)@${PANDOC_KEY}(?:(\\s?)\\[([^[\\]\\n@]*)\\])?`, 'gmu')
  for (const m of taken.join('').matchAll(bare)) {
    const start = m.index + m[1].length
    const key = m[3] ?? m[4]
    const locator = clean(m[6])
    out.push({
      keys: [key],
      items: [{ key, prefix: null, locator, page: pageOf(locator) }],
      command: 'pandoc_bare',
      syntax: 'pandoc',
      start,
      end: m.index + m[0].length,
      locator,
      page: pageOf(locator)
    })
  }
  return out
}

function orgCitations(masked: string): RawCitation[] {
  const out: RawCitation[] = []
  // `[cite/style:global prefix; prefix @a suffix; @b; global suffix]`.
  for (const m of masked.matchAll(/\[cite((?:\/[\w-]+){0,2}):([^[\]\n]*)\]/g)) {
    const items = m[2]
      .split(';')
      .map(bracketItem)
      .filter((i): i is CitationItem => i !== null)
    if (items.length === 0) continue
    out.push(fromItems(items, `cite${m[1]}`, 'org', m.index, m.index + m[0].length))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Sentences

/** Abbreviations whose period never ends a sentence (lowercase, without the final period). */
const ABBREVIATIONS = new Set([
  'al',
  'e.g',
  'i.e',
  'cf',
  'vs',
  'p',
  'pp',
  'fig',
  'figs',
  'eq',
  'eqs',
  'sec',
  'secs',
  'ch',
  'chap',
  'vol',
  'vols',
  'nr',
  'ed',
  'eds',
  'approx',
  'dr',
  'dra',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'sra',
  'srta',
  'st',
  'jr',
  'ud',
  'uds',
  'p.ej',
  'ej',
  'pág',
  'págs',
  'cap',
  'caps',
  'núm',
  'nro',
  'aprox',
  'vid',
  'cfr',
  'ibíd',
  'ibid',
  'cit',
  'art',
  'arts',
  'resp',
  'tab',
  'apdo',
  'pto',
  'av',
  'viz'
])

/** Lines that start a new sentence on their own: headings, list items, LaTeX structure. */
const BLOCK_START = /^[ \t]*(?:#{1,6} |\*+ |[-+*] |\d+[.)] |\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|begin|end|caption)\b)/

function isAbbreviation(text: string, dot: number): boolean {
  // The word before the period, with inner periods (`e.g`, `p. ej` written `p.ej`).
  const m = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, dot - 20), dot))
  if (!m) return false
  const word = m[1].replace(/^\.+/, '').toLowerCase()
  if (ABBREVIATIONS.has(word)) return true
  // An initial (`J. Smith`) or `et al` written with a space in front of it.
  if (/^\p{Lu}$/u.test(m[1])) return true
  const last = word.split('.').pop() ?? ''
  return ABBREVIATIONS.has(last) && word.includes('.')
}

/**
 * The sentences of `masked` (comments and code already blanked, citations too so their periods never split). A
 * sentence ends at `.`, `!` or `?` (plus closing quotes or brackets) followed by whitespace and anything but a lowercase
 * letter, unless the period ends an abbreviation or an initial; and at a blank line or a heading, list item or LaTeX
 * structural command. Offsets are those of `masked`, which are the original text's.
 */
export function sentenceSpans(masked: string): { start: number; end: number }[] {
  const breaks: number[] = []
  // Paragraph and block breaks.
  for (const m of masked.matchAll(/\n[ \t]*\n/g)) breaks.push(m.index + 1)
  let lineStart = 0
  for (const line of masked.split('\n')) {
    if (BLOCK_START.test(line)) {
      breaks.push(lineStart)
      // A heading or a structural command line ends where it ends.
      if (/^[ \t]*(?:#{1,6} |\*+ |\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|caption)\b)/.test(line)) breaks.push(lineStart + line.length)
    }
    lineStart += line.length + 1
  }
  for (const m of masked.matchAll(/[.!?…]+["'”’»)\]]*(?=\s+(\S))/g)) {
    const next = m[1]
    if (/\p{Ll}/u.test(next)) continue
    const dotAt = m.index + m[0].search(/[.!?…]/)
    if (masked[dotAt] === '.' && m[0].replace(/["'”’»)\]]+$/, '') === '.' && isAbbreviation(masked, dotAt)) continue
    breaks.push(m.index + m[0].length)
  }
  const points = [...new Set([0, ...breaks, masked.length])].sort((a, b) => a - b)
  const spans: { start: number; end: number }[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    let start = points[i]
    let end = points[i + 1]
    while (start < end && /\s/.test(masked[start])) start++
    while (end > start && /\s/.test(masked[end - 1])) end--
    if (end > start) spans.push({ start, end })
  }
  return spans
}

/** The sentences of a text, in its own format (comments and code never count). */
export function splitSentences(text: string, format: CiteFormat = detectFormat(text)): Sentence[] {
  return sentenceSpans(maskText(text, format)).map((s) => ({ ...s, text: text.slice(s.start, s.end).replace(/\s+/g, ' ') }))
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing

/**
 * Every citation of the text, in order. LaTeX commands are recognized in every format (Org and Markdown pass raw LaTeX
 * through); pandoc citations only in Markdown, org-cite only in Org.
 */
export function parseCitations(text: string, format: CiteFormat = detectFormat(text)): Citation[] {
  const masked = maskText(text, format)
  const raw = [...latexCitations(masked), ...(format === 'markdown' ? pandocCitations(masked) : []), ...(format === 'org' ? orgCitations(masked) : [])].sort(
    (a, b) => a.start - b.start
  )
  // Citations never overlap: the first one wins.
  const citations: RawCitation[] = []
  for (const c of raw) if (!citations.length || c.start >= citations[citations.length - 1].end) citations.push(c)
  // Citations are blanked for the segmentation, so `[p. 3]` or `\cite[p.~3]{a}` never splits a sentence.
  // A non-space placeholder, so a sentence keeps its citation at either end when it is trimmed.
  const units = masked.split('')
  for (const c of citations) for (let i = c.start; i < c.end; i++) if (units[i] !== '\n') units[i] = 'x'
  const spans = sentenceSpans(units.join(''))
  return citations.map((c) => {
    const span = spans.find((s) => s.start <= c.start && c.start < s.end) ?? { start: c.start, end: c.end }
    return { ...c, sentence: { ...span, text: text.slice(span.start, span.end).replace(/\s+/g, ' ') } }
  })
}

/** The keys cited, each once, in order of first appearance. */
export function citedKeys(citations: Pick<Citation, 'keys'>[]): string[] {
  return [...new Set(citations.flatMap((c) => c.keys))]
}

// ---------------------------------------------------------------------------------------------------------------------
// Includes (followed only by «BibTeX», inside the chosen file's folder; see main/writing/includes.ts)

export interface IncludeRef {
  /** `input`, `include`, `subfile`, or `org_include`. */
  command: string
  path: string
  start: number
}

/** `\input{…}`, `\include{…}`, `\subfile{…}` (outside comments) and Org's `#+INCLUDE: "…"`. */
export function findIncludes(text: string, format: CiteFormat): IncludeRef[] {
  const masked = maskText(text, format)
  const out: IncludeRef[] = []
  for (const m of masked.matchAll(/\\(input|include|subfile)(?![A-Za-z])\s*\{([^{}\n]+)\}/g)) out.push({ command: m[1], path: m[2].trim(), start: m.index })
  if (format === 'org') {
    for (const m of masked.matchAll(/^[ \t]*#\+include:[ \t]*(?:"([^"\n]+)"|(\S+))/gim)) out.push({ command: 'org_include', path: (m[1] ?? m[2]).trim(), start: m.index })
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution against the library

/** What the library knows about the keys a text may cite. */
export interface KeyIndex {
  /** Library papers by citation key; `hasText`: its full text is indexed (a citation of it can be checked). */
  papers: ReadonlyMap<string, { hasText: boolean }>
  /** Keys of papers in the trash. */
  trashed: ReadonlySet<string>
}

export const KEY_STATES = ['ok', 'unknown', 'trashed', 'no_text'] as const
export type KeyState = (typeof KEY_STATES)[number]

export function keyState(key: string, index: KeyIndex): KeyState {
  const paper = index.papers.get(key)
  if (paper) return paper.hasText ? 'ok' : 'no_text'
  return index.trashed.has(key) ? 'trashed' : 'unknown'
}

export interface ResolvedCitation extends Citation {
  states: Record<string, KeyState>
  /** Keys cited more than once in this citation, or also cited by another citation of the same sentence. */
  duplicates: string[]
}

export interface CitationReport {
  citations: ResolvedCitation[]
  /** Each key once, in order of first appearance. */
  keys: string[]
  unknown: string[]
  trashed: string[]
  noText: string[]
  duplicates: string[]
}

export function resolveCitations(citations: Citation[], index: KeyIndex): CitationReport {
  const bySentence = new Map<number, Map<string, number>>()
  for (const c of citations) {
    const seen = bySentence.get(c.sentence.start) ?? new Map<string, number>()
    for (const k of new Set(c.keys)) seen.set(k, (seen.get(k) ?? 0) + 1)
    bySentence.set(c.sentence.start, seen)
  }
  const resolved = citations.map((c): ResolvedCitation => {
    const inSentence = bySentence.get(c.sentence.start)!
    const duplicates = [...new Set(c.keys.filter((k, i) => c.keys.indexOf(k) !== i || (inSentence.get(k) ?? 0) > 1))]
    return { ...c, states: Object.fromEntries(c.keys.map((k) => [k, keyState(k, index)])), duplicates }
  })
  const keys = citedKeys(citations)
  const where = (state: KeyState): string[] => keys.filter((k) => keyState(k, index) === state)
  return {
    citations: resolved,
    keys,
    unknown: where('unknown'),
    trashed: where('trashed'),
    noText: where('no_text'),
    duplicates: [...new Set(resolved.flatMap((c) => c.duplicates))]
  }
}
