export interface BibEntry {
  /** Lowercase entry type: article, inproceedings… */
  type: string
  key: string
  /** Lowercase field name → raw value (braces and LaTeX kept; see latexToText). */
  fields: Record<string, string>
}

/** A field value (or `@string` macro) is cut at this length while it is assembled, so `#` chains cannot grow without end. */
export const MAX_BIB_VALUE = 100_000
const MAX_FIELDS = 200

/** `@type{` or `@type(` at the start of a line: always the start of an entry (an entry still open there is cut). */
const LINE_HEAD = /\n[ \t]*@[ \t]*[A-Za-z]+[ \t]*[{(]/y

/**
 * The index of the bracket that closes the entry opened at `open` (`{` or `(`). An unbalanced entry ends where the next
 * line starts a new entry, or at the text's end, so a stray brace loses one entry rather than the rest of the file.
 */
function entryEnd(text: string, open: number): number {
  const paren = text[open] === '('
  let braces = paren ? 0 : 1
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') braces++
    else if (c === '}') {
      braces--
      if (!paren && braces === 0) return i
      if (braces < 0) braces = 0
    } else if (paren && c === ')' && braces === 0) return i
    else if (c === '\n') {
      LINE_HEAD.lastIndex = i
      if (LINE_HEAD.test(text)) return i
    }
  }
  return text.length
}

function braceEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return s.length
}

function quoteEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '"' && depth === 0) return i
  }
  return s.length
}

const FIELD_NAME = /([A-Za-z][\w:.+-]*)\s*=\s*/y
const WORD = /[^\s,#{}"]+/y

/** The index after the next `,` outside braces and quotes (or the end): where reading resumes after a broken field. */
function nextComma(body: string, from: number): number {
  let depth = 0
  let quoted = false
  for (let i = from; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '"' && depth === 0) quoted = !quoted
    else if (c === ',' && depth === 0 && !quoted) return i + 1
  }
  return body.length
}

/** Characters that may still be appended to values across one file; once spent, macros expand to ''. */
interface Budget {
  left: number
}

/**
 * `name = value` pairs; a value is `{…}`, `"…"`, a number or a macro, and pieces join with `#`. Every appended piece is
 * charged to the file's `budget`, so a big macro referenced by every field of every entry cannot multiply the input.
 */
function parseFields(body: string, strings: ReadonlyMap<string, string>, budget: Budget): Record<string, string> {
  const fields: Record<string, string> = {}
  let count = 0
  let i = 0
  const skipSpace = (): void => {
    while (i < body.length && /\s/.test(body[i])) i++
  }
  while (count < MAX_FIELDS) {
    while (i < body.length && (body[i] === ',' || /\s/.test(body[i]))) i++
    if (i >= body.length) break
    FIELD_NAME.lastIndex = i
    const m = FIELD_NAME.exec(body)
    if (!m) {
      // Not `name =`: skip to the next field rather than losing the rest of the entry.
      const next = nextComma(body, i)
      if (next <= i) break
      i = next
      continue
    }
    i = FIELD_NAME.lastIndex
    let value = ''
    for (;;) {
      skipSpace()
      const c = body[i]
      let piece: string
      if (c === '{') {
        const end = braceEnd(body, i)
        piece = body.slice(i + 1, end)
        i = end + 1
      } else if (c === '"') {
        const end = quoteEnd(body, i)
        piece = body.slice(i + 1, end)
        i = end + 1
      } else {
        WORD.lastIndex = i
        const word = WORD.exec(body)
        if (!word) break
        const macro = strings.get(word[0].toLowerCase())
        piece = macro === undefined ? word[0] : budget.left > 0 ? macro : ''
        i = WORD.lastIndex
      }
      budget.left -= piece.length
      if (value.length < MAX_BIB_VALUE) {
        value += piece
        if (value.length > MAX_BIB_VALUE) value = value.slice(0, MAX_BIB_VALUE)
      }
      skipSpace()
      if (body[i] !== '#') break
      i++
    }
    fields[m[1].toLowerCase()] = value
    count++
  }
  return fields
}

/**
 * Every entry of a .bib file, at most `maxEntries`; `@string` macros are expanded, `@comment` and `@preamble` skipped,
 * entries without a key dropped. Never throws; linear in the input.
 */
export function parseBibtex(text: string, maxEntries = Number.POSITIVE_INFINITY): BibEntry[] {
  const head = /@\s*([A-Za-z]+)\s*([{(])/g
  const entries: BibEntry[] = []
  const strings = new Map<string, string>()
  const budget: Budget = { left: Math.max(2 * text.length, 4_000_000) }
  while (entries.length < maxEntries) {
    const m = head.exec(text)
    if (!m) break
    const open = m.index + m[0].length - 1
    const end = entryEnd(text, open)
    head.lastIndex = end + 1
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'preamble') continue
    const body = text.slice(open + 1, end)
    if (type === 'string') {
      for (const [name, value] of Object.entries(parseFields(body, strings, budget))) strings.set(name, value)
      continue
    }
    const comma = body.indexOf(',')
    const key = comma < 0 ? '' : body.slice(0, comma).trim()
    if (!key || /\s/.test(key)) continue
    entries.push({ type, key, fields: parseFields(body.slice(comma + 1), strings, budget) })
  }
  return entries
}

const ACCENTS: Record<string, string> = {
  "'": '\u0301',
  '`': '\u0300',
  '^': '\u0302',
  '"': '\u0308',
  '~': '\u0303',
  '=': '\u0304',
  '.': '\u0307',
  c: '\u0327',
  u: '\u0306',
  v: '\u030C',
  H: '\u030B',
  k: '\u0328'
}
const LETTERS: Record<string, string> = {
  ss: 'ß',
  aa: 'å',
  AA: 'Å',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  o: 'ø',
  O: 'Ø',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ'
}
const LOGOS: Record<string, string> = { LaTeX: 'LaTeX', LaTeXe: 'LaTeX2e', TeX: 'TeX', BibTeX: 'BibTeX' }

/**
 * A BibTeX value as plain text: accents and special letters decoded, escapes and other commands dropped, braces removed.
 * Whitespace is collapsed first, so no pattern below ever meets a long run of it.
 */
export function latexToText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    // Inline math: delimiters dropped and command names kept ("$O(n \log n)$" → "O(n log n)").
    .replace(/(?<!\\)\$([^$]{0,500}?)(?<!\\)\$/g, (_m, math: string) => math.replace(/\\([A-Za-z]+)/g, '$1'))
    .replace(/\\([`'^"~=.]) ?(?:\{ ?)?(?:\\([ij])|([A-Za-z]))(?: ?\})?/g, (_m, accent: string, dotless: string | undefined, letter: string | undefined) =>
      `${dotless ?? letter}${ACCENTS[accent]}`.normalize('NFC')
    )
    .replace(/\\([cuvHk])(?: ?\{ ?([A-Za-z]) ?\}| ([A-Za-z])(?![A-Za-z]))/g, (_m, accent: string, braced: string | undefined, bare: string | undefined) =>
      `${braced ?? bare}${ACCENTS[accent]}`.normalize('NFC')
    )
    .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i|j)(?![A-Za-z]) ?/g, (_m, name: string) => LETTERS[name])
    .replace(/\\(LaTeXe|LaTeX|TeX|BibTeX)(?![A-Za-z]) ?/g, (_m, name: string) => LOGOS[name])
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/\\[A-Za-z]+ ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const AND = /\s+and\s+/iy

/** Names of an author field, split on «and» outside braces (a braced name is an organization). Linear in the input. */
export function splitBibNames(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /\s/.test(c) && (i === 0 || !/\s/.test(raw[i - 1]))) {
      AND.lastIndex = i
      if (AND.test(raw)) {
        out.push(raw.slice(start, i))
        i = AND.lastIndex - 1
        start = i + 1
      }
    }
  }
  out.push(raw.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}
