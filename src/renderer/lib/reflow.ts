import { normalizeWithMap } from '../../shared/textMatch'

/**
 * A reflowed piece of a PDF page: a section heading, a paragraph, or a "margin" line (a running
 * header, footer or page number that repeats across pages; see {@link repeatedLines}), shown dimmed.
 */
export interface Block {
  kind: 'heading' | 'paragraph' | 'margin'
  text: string
}

export interface TextMatch {
  block: number
  start: number
  end: number
}

/** Joins pdf.js text items the same way the indexer does: a line break wherever an item ends a line. */
export function joinTextItems(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  return items.map((item) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : '')).join('')
}

/** Comparable form of a line for spotting running headers/footers: case, spacing and the digits themselves don't matter. */
export function lineKey(line: string): string {
  return line.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().replace(/\d+/g, '#')
}

const SENTENCE_END = /[.!?]["'”’)\]]?$/
const STARTS_UPPER = /^["“'‘(\[]?[\p{Lu}\d]/u
const NUMBERED_HEADING = /^(?:\d{1,2}(?:\.\d{1,2})*\.?|[IVX]{1,5}\.)\s+\p{Lu}/u
const KNOWN_HEADING =
  /^(?:abstract|introduction|related work|background|methods?|methodology|results|discussion|conclusions?|references|bibliography|acknowledge?ments|appendix|resumen|introducción|metodología|resultados|discusión|conclusión|conclusiones|referencias|bibliografía|agradecimientos):?$/i
const MAX_HEADING_CHARS = 60
const MAX_HEADING_WORDS = 8
/** A line shorter than this share of the page's longest line counts as "noticeably short" (a paragraph's last line). */
const SHORT_LINE_RATIO = 0.8

/**
 * Whether a whole line looks like a section title: short (at most 8 words and 60 characters), not
 * ending like a sentence or a clause, and either numbered ("1 Introduction", "2.3 Results",
 * "IV. Method"), all caps ("RELATED WORK") or a well-known unnumbered section name ("Abstract").
 */
function isHeading(line: string): boolean {
  if (line.length > MAX_HEADING_CHARS || line.split(' ').length > MAX_HEADING_WORDS) return false
  if (/[.,;]$/.test(line)) return false
  if (NUMBERED_HEADING.test(line) || KNOWN_HEADING.test(line)) return true
  const letters = line.replace(/[^\p{L}]/gu, '')
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
}

/**
 * Joins the lines of one paragraph. A hyphen (or soft hyphen) at a line end between letters, with
 * the next line starting lowercase, is a word broken across lines ("detec-" + "tion" → "detection");
 * any other hyphen at a line end is kept with no space ("COVID-" + "19" → "COVID-19"). Other lines
 * are joined with a space. Hyphens inside a line ("state-of-the-art") are never touched.
 */
function joinLines(lines: string[]): string {
  let text = ''
  for (const line of lines) {
    if (!text) text = line
    else if (/\p{L}\u00ad$/u.test(text)) text = text.slice(0, -1) + line
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line
    else if (/-$/.test(text)) text += line
    else text += ` ${line}`
  }
  return text.replace(/\u00ad/g, '')
}

/** Indexes of the first two and last two non-blank lines: where running headers and footers sit. */
function edgeIndexes(lines: string[]): Set<number> {
  const nonBlank = lines.flatMap((line, i) => (line ? [i] : []))
  return new Set([...nonBlank.slice(0, 2), ...nonBlank.slice(-2)])
}

/**
 * Turns the raw text of a PDF page (lines as pdf.js laid them out) into readable blocks.
 *
 * Heuristics, kept deliberately simple:
 * - a blank line ends a paragraph;
 * - a line that looks like a section title (see {@link isHeading}) becomes a heading of its own;
 * - a line ending a sentence (. ! ?) that is noticeably shorter than the page's longest line (under
 *   80% of it), followed by a line starting with an uppercase letter or a digit, ends a paragraph:
 *   a full-width line ending a sentence usually just happens to break there;
 * - every other line continues the current paragraph (see {@link joinLines} for hyphenation);
 * - among the first and last two lines, one whose {@link lineKey} is in `repeated` becomes a
 *   "margin" block (running header, footer or page number) instead of joining the text.
 */
export function reflowPage(raw: string, repeated: ReadonlySet<string> = new Set()): Block[] {
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim())
  const edges = edgeIndexes(lines)
  const isMargin = (i: number): boolean => edges.has(i) && repeated.has(lineKey(lines[i]))
  const longest = Math.max(0, ...lines.map((line, i) => (isMargin(i) ? 0 : line.length)))

  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: joinLines(paragraph) })
    paragraph = []
  }

  lines.forEach((line, i) => {
    if (!line) return flush()
    if (isMargin(i)) {
      flush()
      blocks.push({ kind: 'margin', text: line })
      return
    }
    if (isHeading(line)) {
      flush()
      blocks.push({ kind: 'heading', text: line })
      return
    }
    const prev = paragraph[paragraph.length - 1]
    if (prev && SENTENCE_END.test(prev) && prev.length < longest * SHORT_LINE_RATIO && STARTS_UPPER.test(line)) flush()
    paragraph.push(line)
  })
  flush()
  return blocks
}

/** Share of pages a line must repeat on (at a page's top or bottom) to count as a running header/footer. */
const REPEAT_RATIO = 0.6

/**
 * Keys ({@link lineKey}) of the lines among each page's first and last two that repeat on at least
 * 60% of `pages` (running headers, footers and page numbers; digits are ignored, so "3" and "4"
 * count as the same line). Needs at least two pages.
 */
export function repeatedLines(pages: string[]): Set<string> {
  const result = new Set<string>()
  if (pages.length < 2) return result
  const counts = new Map<string, number>()
  for (const page of pages) {
    const lines = page.split(/\r?\n/).map((line) => line.trim())
    const keys = new Set([...edgeIndexes(lines)].map((i) => lineKey(lines[i])).filter(Boolean))
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counts) if (count >= pages.length * REPEAT_RATIO) result.add(key)
  return result
}

/** End (exclusive) of the code point at `idx` in `s` plus any combining marks right after it. */
function clusterEnd(s: string, idx: number): number {
  const codePointAt = (i: number): string => String.fromCodePoint(s.codePointAt(i) ?? 0)
  let end = idx + codePointAt(idx).length
  while (end < s.length && /\p{M}/u.test(codePointAt(end))) end += codePointAt(end).length
  return end
}

/**
 * {@link normalizeWithMap} plus diacritic folding ("ó" → "o"), with `map[i]` the offset in `s`
 * of the character that produced the i-th UTF-16 unit of `text`.
 */
function foldWithMap(s: string): { text: string; map: number[] } {
  const normalized = normalizeWithMap(s)
  let text = ''
  const map: number[] = []
  let unit = 0
  // normalizeWithMap's map has one entry per code point of its text.
  for (const cp of normalized.text) {
    const folded = cp.normalize('NFD').replace(/\p{M}/gu, '')
    text += folded
    for (let k = 0; k < folded.length; k++) map.push(normalized.map[unit])
    unit++
  }
  return { text, map }
}

/**
 * Every non-overlapping occurrence of `query` in each block's text, ignoring case, diacritics,
 * spacing and typographic quote/dash variants; offsets are in the original block text.
 */
export function findMatches(blocksText: string[], query: string): TextMatch[] {
  const needle = foldWithMap(query).text
  if (!needle) return []
  const matches: TextMatch[] = []
  blocksText.forEach((original, block) => {
    const { text, map } = foldWithMap(original)
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      matches.push({ block, start: map[at], end: clusterEnd(original, map[at + needle.length - 1]) })
    }
  })
  return matches
}
