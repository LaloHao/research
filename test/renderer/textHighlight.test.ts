import { describe, expect, it } from 'vitest'
import { normalizeForMatch } from '../../src/shared/textMatch'
import { findQuoteRanges } from '../../src/renderer/lib/textHighlight'

/** Reconstructs the matched text from the ranges, one node's slice per range, for comparison. */
function reconstruct(nodes: string[], ranges: { nodeIndex: number; start: number; end: number }[]): string {
  return ranges.map((r) => nodes[r.nodeIndex].slice(r.start, r.end)).join(' ')
}

describe('findQuoteRanges', () => {
  it('finds a quote inside a single text node, at its exact offsets', () => {
    const nodes = ['The quick brown fox jumps over the lazy dog.']
    const quote = 'brown fox jumps'
    const start = nodes[0].indexOf(quote)
    expect(findQuoteRanges(nodes, quote)).toEqual([{ nodeIndex: 0, start, end: start + quote.length }])
  })

  it('finds a quote spanning several text nodes, as rendered markdown would produce', () => {
    // e.g. "quick **brown** fox" renders as three text nodes: "quick ", "brown", " fox"
    const nodes = ['quick ', 'brown', ' fox jumps']
    const ranges = findQuoteRanges(nodes, 'quick brown fox jumps')
    expect(ranges.map((r) => r.nodeIndex)).toEqual([0, 1, 2])
    expect(normalizeForMatch(reconstruct(nodes, ranges))).toBe('quick brown fox jumps')
    for (const r of ranges) {
      expect(r.start).toBeGreaterThanOrEqual(0)
      expect(r.end).toBeLessThanOrEqual(nodes[r.nodeIndex].length)
      expect(r.end).toBeGreaterThan(r.start)
    }
  })

  it('matches across case and whitespace differences, with accents preserved on both sides', () => {
    const nodes = ['Se  propone un método\nnovedoso de detección.']
    const ranges = findQuoteRanges(nodes, 'SE PROPONE UN MÉTODO NOVEDOSO DE DETECCIÓN')
    expect(ranges).toEqual([{ nodeIndex: 0, start: 0, end: nodes[0].length - 1 }])
  })

  it('joins a quote split across nodes by a line-break hyphen', () => {
    const nodes = ['We propose a novel ', 'detec-', 'tion', ' method for anomalies.']
    const ranges = findQuoteRanges(nodes, 'novel detection method')
    expect(ranges.map((r) => r.nodeIndex)).toEqual([0, 1, 2, 3])
    expect(normalizeForMatch(reconstruct(nodes, ranges))).toBe('novel detection method')
  })

  it('returns an empty array when the quote is not found', () => {
    const nodes = ['The quick brown fox jumps over the lazy dog.']
    expect(findQuoteRanges(nodes, 'a completely unrelated invented sentence')).toEqual([])
  })

  it('returns an empty array for a blank quote', () => {
    expect(findQuoteRanges(['some text'], '   ')).toEqual([])
  })
})
