import { locateInOriginal } from '../../shared/textMatch'

export interface QuoteRange {
  nodeIndex: number
  start: number
  end: number
}

/**
 * Locates `quote` across a sequence of text-node strings (e.g. the text nodes of a rendered
 * markdown document) and returns the per-node ranges it spans, tolerant of case, diacritic and
 * whitespace differences and of hyphen line breaks, the same as {@link locateInOriginal}.
 *
 * Nodes are joined with a single space before matching, the way adjacent DOM text nodes read as
 * continuous prose, so a quote can span node boundaries (including a hyphen split across two
 * nodes, e.g. "detec-" + "tion"). Empty when the quote is not found.
 */
export function findQuoteRanges(nodeTexts: string[], quote: string): QuoteRange[] {
  if (!quote.trim()) return []

  const nodeStarts: number[] = []
  let joined = ''
  for (const text of nodeTexts) {
    nodeStarts.push(joined.length)
    joined += text + ' '
  }

  const match = locateInOriginal(quote, joined)
  if (!match) return []

  const ranges: QuoteRange[] = []
  nodeTexts.forEach((text, nodeIndex) => {
    const nodeStart = nodeStarts[nodeIndex]
    const nodeEnd = nodeStart + text.length
    const start = Math.max(match.start, nodeStart) - nodeStart
    const end = Math.min(match.end, nodeEnd) - nodeStart
    if (end > start) ranges.push({ nodeIndex, start, end })
  })
  return ranges
}
