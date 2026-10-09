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
    if (!q.slice(0, 3).includes(t[i].word)) continue
    let qi = 0
    let last = -1
    for (let k = i; k < Math.min(t.length, i + window) && qi < q.length; k++) {
      // Skip quote tokens that are missing from the text, then try to match this text token.
      let probe = qi
      while (probe < q.length && probe - qi < 3 && q[probe] !== t[k].word) probe++
      if (probe < q.length && q[probe] === t[k].word) {
        qi = probe + 1
        last = k
      }
    }
    const matched = last < 0 ? 0 : countMatched(q, t.slice(i, last + 1).map((x) => x.word))
    const score = matched / q.length
    if (last >= 0 && (!best || score > best.score)) best = { start: t[i].start, end: t[last].end, score }
  }
  return best && best.score >= threshold ? best : null
}

/**
 * Longest common subsequence length between the quote tokens and a text window, where a text
 * token that equals the concatenation of two consecutive quote tokens (e.g. a quote has
 * "fine-tune" as two tokens but the source text had it joined by a line-break hyphen, collapsing
 * to one "finetune" token) counts as matching both.
 */
function countMatched(q: string[], w: string[]): number {
  const dp = Array.from({ length: q.length + 1 }, () => new Array<number>(w.length + 1).fill(0))
  for (let i = 1; i <= q.length; i++) {
    for (let j = 1; j <= w.length; j++) {
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      if (q[i - 1] === w[j - 1]) dp[i][j] = Math.max(dp[i][j], dp[i - 1][j - 1] + 1)
      if (i >= 2 && q[i - 2] + q[i - 1] === w[j - 1]) dp[i][j] = Math.max(dp[i][j], dp[i - 2][j - 1] + 2)
    }
  }
  return dp[q.length][w.length]
}

export function quoteFound(quote: string, text: string): boolean {
  return findInNormalized(normalizeForMatch(quote), normalizeForMatch(text)) !== null
}
