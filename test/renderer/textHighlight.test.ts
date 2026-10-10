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

  it('finds a quote that starts and ends mid-node, spanning a node boundary', () => {
    const nodes = ['Lorem ipsum dolor sit amet, ', 'consectetur adipiscing elit, sed do eiusmod tempor incididunt.']
    const quote = 'amet, consectetur adipiscing elit, sed'
    const start0 = nodes[0].indexOf('amet,')
    const end1 = nodes[1].indexOf('sed') + 'sed'.length
    expect(findQuoteRanges(nodes, quote)).toEqual([
      { nodeIndex: 0, start: start0, end: nodes[0].length },
      { nodeIndex: 1, start: 0, end: end1 }
    ])
  })

  it('matches through an inline marker node the quote does not mention (the token-window fallback)', () => {
    // e.g. "a critical[2] step" where [2] is a footnote marker rendered as its own node, directly
    // against "critical" with no whitespace in the source; the quote never mentions "2", and the
    // space our join inserts around it isn't in the source either, so this can only match through
    // locateInOriginal's token-window search tolerating a text token the quote doesn't have — not
    // a plain substring search, which would fail on the inserted "2". The returned range still
    // spans node 2 (it sits between two matched words), so the marker ends up highlighted too.
    const nodes = ['We propose a ', 'critical', '2', ' step forward in the field.']
    const quote = 'propose a critical step forward'
    const ranges = findQuoteRanges(nodes, quote)
    expect(ranges.map((r) => r.nodeIndex)).toEqual([0, 1, 2, 3])
    expect(normalizeForMatch(reconstruct(nodes, ranges))).toBe('propose a critical 2 step forward')
  })

  it('returns an empty array when the quote is not found', () => {
    const nodes = ['The quick brown fox jumps over the lazy dog.']
    expect(findQuoteRanges(nodes, 'a completely unrelated invented sentence')).toEqual([])
  })

  it('returns an empty array for a blank quote', () => {
    expect(findQuoteRanges(['some text'], '   ')).toEqual([])
  })
})
