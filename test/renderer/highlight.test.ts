import { describe, expect, it } from 'vitest'
import { matchSpans } from '../../src/renderer/lib/highlight'

describe('matchSpans', () => {
  it('finds the indices of the spans a quote is split across', () => {
    const spans = ['The ', 'quick brown ', 'fox jumps', ' over the lazy dog.']
    expect(matchSpans(spans, 'quick brown fox jumps')).toEqual([1, 2])
  })

  it('finds a quote split across spans by a line-break hyphen', () => {
    const spans = ['We propose a novel ', 'detec-', 'tion', ' method for anomalies.']
    expect(matchSpans(spans, 'novel detection method')).toEqual([0, 1, 2, 3])
  })

  it('returns an empty array for a quote that is not in the spans', () => {
    const spans = ['The quick brown fox jumps over the lazy dog.']
    expect(matchSpans(spans, 'a completely unrelated invented sentence')).toEqual([])
  })
})
