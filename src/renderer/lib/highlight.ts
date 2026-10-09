import { findInNormalized, normalizeForMatch } from '../../shared/textMatch'

/**
 * Indices of the spans (from a PDF text layer) that a quote overlaps, after normalizing each span
 * and the quote the same way evidence is matched against extracted text. Empty when the quote is
 * not found. Spans that normalize to nothing (empty or whitespace-only) are skipped entirely and
 * can never appear in the result.
 */
export function matchSpans(spanTexts: string[], quote: string): number[] {
  const normalizedQuote = normalizeForMatch(quote)
  if (!normalizedQuote) return []

  const ranges: { index: number; start: number; end: number }[] = []
  let text = ''
  spanTexts.forEach((raw, index) => {
    const normalized = normalizeForMatch(raw)
    if (!normalized) return
    const start = text.length
    text += normalized
    ranges.push({ index, start, end: text.length })
    text += ' '
  })

  const match = findInNormalized(normalizedQuote, text)
  if (!match) return []
  return ranges.filter((r) => r.start < match.end && r.end > match.start).map((r) => r.index)
}
