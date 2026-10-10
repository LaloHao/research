export const MATCH_THRESHOLD = 0.85

/** Comparable form of text from PDFs, web pages and LLM quotes. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2')
    .replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

interface Token {
  word: string
  start: number
  end: number
}

function tokens(s: string): Token[] {
  return [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ word: m[0], start: m.index!, end: m.index! + m[0].length }))
}

/**
 * Locates `quote` in `text` (both already normalized). Exact substring first; otherwise the best
 * in-order token match inside a window, accepted when it covers `threshold` of the quote's tokens.
 */
export function findInNormalized(quote: string, text: string, threshold = MATCH_THRESHOLD): { start: number; end: number; score: number } | null {
  if (!quote) return null
  const exact = text.indexOf(quote)
  if (exact >= 0) return { start: exact, end: exact + quote.length, score: 1 }
  const q = tokens(quote).map((t) => t.word)
  if (q.length === 0) return null
  const t = tokens(text)
  const window = Math.ceil(q.length * 1.5) + 2
  let best: { start: number; end: number; score: number } | null = null
  for (let i = 0; i < t.length; i++) {
    const startWord = t[i].word
    const startMerge = i + 1 < t.length ? startWord + t[i + 1].word : null
    if (!q.slice(0, 3).includes(startWord) && !(startMerge && q.slice(0, 3).includes(startMerge))) continue
    let qi = 0
    let last = -1
    let k = i
    while (k < Math.min(t.length, i + window) && qi < q.length) {
      const word = t[k].word
      const mergedWithNext = k + 1 < t.length ? word + t[k + 1].word : null
      // Skip quote tokens that are missing from the text, then try to match this text token
      // (or, when a hyphenated word was split across two text tokens, this text token plus the
      // next one together).
      let probe = qi
      while (
        probe < q.length &&
        probe - qi < 3 &&
        q[probe] !== word &&
        !(probe + 1 < q.length && q[probe] + q[probe + 1] === word) &&
        !(mergedWithNext && q[probe] === mergedWithNext)
      )
        probe++
      if (probe < q.length && q[probe] === word) {
        qi = probe + 1
        last = k
        k++
      } else if (probe + 1 < q.length && q[probe] + q[probe + 1] === word) {
        qi = probe + 2
        last = k
        k++
      } else if (mergedWithNext && probe < q.length && q[probe] === mergedWithNext) {
        qi = probe + 1
        last = k + 1
        k += 2
      } else {
        k++
      }
    }
    const matched = last < 0 ? 0 : countMatched(q, t.slice(i, last + 1).map((x) => x.word))
    const score = matched / q.length
    if (last >= 0 && (!best || score > best.score)) best = { start: t[i].start, end: t[last].end, score }
  }
  return best && best.score >= threshold ? best : null
}

/**
 * Longest common subsequence length between the quote tokens and a text window, with two
 * hyphen-split-aware transitions on top of the plain LCS recurrence:
 * - a text token that equals the concatenation of two consecutive quote tokens (e.g. a quote has
 *   "fine-tune" as two tokens but the source text had it joined by a line-break hyphen, collapsing
 *   to one "finetune" token) counts as matching both quote tokens;
 * - the mirror case: a quote token that equals the concatenation of two consecutive text tokens
 *   (e.g. the quote has "finetune" as one token but the source text has it hyphenated as two,
 *   "fine-tune") counts as matching that one quote token.
 * Both are additional candidate transitions on top of the base recurrence, so dp[i][j] <= i
 * always holds (it can never exceed the number of quote tokens considered).
 */
function countMatched(q: string[], w: string[]): number {
  const dp = Array.from({ length: q.length + 1 }, () => new Array<number>(w.length + 1).fill(0))
  for (let i = 1; i <= q.length; i++) {
    for (let j = 1; j <= w.length; j++) {
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      if (q[i - 1] === w[j - 1]) dp[i][j] = Math.max(dp[i][j], dp[i - 1][j - 1] + 1)
      if (i >= 2 && q[i - 2] + q[i - 1] === w[j - 1]) dp[i][j] = Math.max(dp[i][j], dp[i - 2][j - 1] + 2)
      if (j >= 2 && q[i - 1] === w[j - 2] + w[j - 1]) dp[i][j] = Math.max(dp[i][j], dp[i - 1][j - 2] + 1)
    }
  }
  return dp[q.length][w.length]
}

export function quoteFound(quote: string, text: string): boolean {
  return findInNormalized(normalizeForMatch(quote), normalizeForMatch(text)) !== null
}

const SINGLE_QUOTES = /[‘’‚‛′]/
const DOUBLE_QUOTES = /[“”„‟″]/
const DASHES = /[‐-―−]/
const WHITESPACE = /\s/
const LETTER = /\p{L}/u
const LOWER_LETTER = /\p{Ll}/u
const COMBINING_MARK = /\p{M}/u

interface Unit {
  ch: string
  orig: number
}

/** UTF-16 length of the code point starting at `idx` in `s` (1, or 2 for a surrogate pair). */
function codePointLength(s: string, idx: number): number {
  const cp = s.codePointAt(idx)
  return cp !== undefined && cp > 0xffff ? 2 : 1
}

/**
 * Same normalization pipeline as {@link normalizeForMatch}, applied unit-by-unit so every
 * character of the result can be traced back to the original string. Mirrors each step:
 * NFKC (per grapheme cluster — a base code point plus any combining marks that follow it, which
 * covers both single-character expansions like ligatures and a base+mark pair like "o" + U+0301
 * composing into "ó"; text extracted from a PDF can arrive either way), quote/dash folding,
 * hyphen-linebreak and hyphen-space joins, whitespace collapsing, trim, lowercasing.
 *
 * Caveat: `.toLowerCase()` can fold a character like the Greek final sigma ("Σ" at the end of a
 * word lowercases to "ς", elsewhere to "σ") based on its surrounding context, not a per-unit rule;
 * this function lowercases each unit independently, so that context-dependent choice isn't
 * reproduced (a plain per-unit `.toLowerCase()` already picks "σ" in both positions, same as
 * `normalizeForMatch`, so the two stay equal — this only matters if that ever changes).
 */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let units: Unit[] = []
  let i = 0
  while (i < s.length) {
    const len = codePointLength(s, i)
    let clusterEnd = i + len
    // A grapheme cluster: the base code point plus any combining marks right after it, so NFKC
    // composes them together instead of leaving a decomposed base+mark pair unmatched against a
    // precomposed quote (or vice versa).
    while (clusterEnd < s.length) {
      const markLen = codePointLength(s, clusterEnd)
      if (!COMBINING_MARK.test(s.slice(clusterEnd, clusterEnd + markLen))) break
      clusterEnd += markLen
    }
    const cluster = s.slice(i, clusterEnd)
    for (const ec of cluster.normalize('NFKC')) units.push({ ch: ec, orig: i })
    i = clusterEnd
  }

  for (const u of units) {
    if (SINGLE_QUOTES.test(u.ch)) u.ch = "'"
    else if (DOUBLE_QUOTES.test(u.ch)) u.ch = '"'
    else if (DASHES.test(u.ch)) u.ch = '-'
  }

  // (\p{L})-\s*\n\s*(\p{L}) -> $1$2: a hyphen at a line break, between two letters, is dropped
  // along with the surrounding whitespace, joining the letters.
  units = joinAcrossGap(units, (j) => {
    if (!(LETTER.test(units[j].ch) && units[j + 1]?.ch === '-')) return null
    let k = j + 2
    let sawNewline = false
    while (k < units.length && WHITESPACE.test(units[k].ch)) {
      if (units[k].ch === '\n') sawNewline = true
      k++
    }
    if (!sawNewline || k === j + 2 || k >= units.length || !LETTER.test(units[k].ch)) return null
    return k
  })

  // (\p{Ll})- (\p{Ll}) -> $1$2: a hyphen followed by exactly one space, between two lowercase
  // letters, is dropped along with that space.
  units = joinAcrossGap(units, (j) => {
    if (!(LOWER_LETTER.test(units[j].ch) && units[j + 1]?.ch === '-' && units[j + 2]?.ch === ' ')) return null
    const k = j + 3
    if (k >= units.length || !LOWER_LETTER.test(units[k].ch)) return null
    return k
  })

  // \s+ -> ' ': collapse runs of whitespace to a single space.
  const collapsed: Unit[] = []
  for (let j = 0; j < units.length; ) {
    if (WHITESPACE.test(units[j].ch)) {
      collapsed.push({ ch: ' ', orig: units[j].orig })
      while (j < units.length && WHITESPACE.test(units[j].ch)) j++
    } else {
      collapsed.push(units[j])
      j++
    }
  }

  // .trim(): drop a leading/trailing single space left over from the collapse above.
  let start = 0
  let end = collapsed.length
  if (start < end && collapsed[start].ch === ' ') start++
  if (end > start && collapsed[end - 1].ch === ' ') end--
  const trimmed = collapsed.slice(start, end)

  // .toLowerCase(): applied per unit; a rare locale-independent expansion (e.g. İ -> i̇) yields
  // more than one lowercase unit, each still pointing at the same original index.
  const lowered: Unit[] = []
  for (const u of trimmed) {
    for (const lc of u.ch.toLowerCase()) lowered.push({ ch: lc, orig: u.orig })
  }

  return { text: lowered.map((u) => u.ch).join(''), map: lowered.map((u) => u.orig) }
}

/**
 * Scans `units` left to right; whenever `match(j)` (tried at the current position) finds a gap
 * worth joining, it returns the index of the unit right after the gap. Both the unit at `j` and
 * that one are kept (everything strictly between is dropped) and the scan resumes right after it
 * — never at it — so a letter consumed by one join can't also start the next one, the same way a
 * global, non-overlapping regex replace advances `lastIndex` past the whole match.
 */
function joinAcrossGap(units: Unit[], match: (j: number) => number | null): Unit[] {
  const result: Unit[] = []
  let j = 0
  while (j < units.length) {
    const next = match(j)
    if (next === null) {
      result.push(units[j])
      j++
    } else {
      result.push(units[j], units[next]) // the letters on either side of the gap
      j = next + 1 // resume after the second letter; it can't start another match
    }
  }
  return result
}

/**
 * Finds `quote` inside `original` the way {@link quoteFound} does, but returns the quote's
 * position in `original` itself rather than in its normalized form.
 */
export function locateInOriginal(quote: string, original: string): { start: number; end: number } | null {
  const { text, map } = normalizeWithMap(original)
  const match = findInNormalized(normalizeForMatch(quote), text)
  if (!match || match.end <= match.start) return null
  const lastIdx = map[match.end - 1]
  return { start: map[match.start], end: lastIdx + codePointLength(original, lastIdx) }
}
