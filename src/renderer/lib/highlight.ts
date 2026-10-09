import { findInNormalized, normalizeForMatch } from '../../shared/textMatch'

/**
 * Indices of the spans (from a PDF text layer) that a quote overlaps, after normalizing each span
 * and the quote the same way evidence is matched against extracted text. Empty when the quote is
 * not found.
 */
export function matchSpans(spanTexts: string[], quote: string): number[] {
  const normalizedQuote = normalizeForMatch(quote)
  if (!normalizedQuote) return []

  const ranges: { start: number; end: number }[] = []
  let text = ''
  for (const raw of spanTexts) {
    const normalized = normalizeForMatch(raw)
    const start = text.length
    text += normalized
    ranges.push({ start, end: text.length })
    text += ' '
  }

  const match = findInNormalized(normalizedQuote, text)
  if (!match) return []
  return ranges.reduce<number[]>((indices, range, i) => {
    if (range.start < match.end && range.end > match.start) indices.push(i)
    return indices
  }, [])
}
