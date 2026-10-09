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
