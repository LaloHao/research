import { locateInOriginal } from '../../shared/textMatch'

export interface QuoteRange {
  nodeIndex: number
  start: number
  end: number
}

/**
 * Locates `quote` across a sequence of text-node strings (e.g. the text nodes of a rendered
 * markdown document) and returns the per-node ranges it spans, the same as
 * {@link locateInOriginal}: tolerant of case and whitespace differences, of equivalent Unicode
 * forms (e.g. a precomposed accented letter vs. a base letter plus a combining mark — NOT of
 * accents being present on one side and absent on the other, which are different characters and
 * never match), and of a hyphenated line break.
 *
 * Nodes are joined with a single space before matching, the way adjacent DOM text nodes read as
 * continuous prose, so a quote can span node boundaries (including a hyphen split across two
 * nodes, e.g. "detec-" + "tion"). That inserted space may not correspond to anything in the
 * source (inline markup, e.g. emphasis or an inline footnote marker, can abut a word with no
 * whitespace at all) — when that makes the joined text differ from an exact-substring match,
 * matching falls back to {@link locateInOriginal}'s token-window search, which tolerates text
 * tokens the quote doesn't mention (skipped) as long as every quote token is still found in
 * order; see the "tolerates an inline marker node with no corresponding quote text" test below.
 * Empty when the quote is not found.
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
