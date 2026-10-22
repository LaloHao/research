import { describe, expect, it } from 'vitest'
import { checkCounts, citeCheckMarkdown, entryOutcome, weakestOutcome, type CheckEntry, type CiteCheckResult } from '../../../src/shared/writing/citeCheck'

const entry = (patch: Partial<CheckEntry>): CheckEntry => ({ key: 'a', verdict: null, reason: null, quote: null, page: null, found: false, note: null, ...patch })

describe('citeCheck', () => {
  it('reads a supporting verdict without its quote found as no evidence', () => {
    expect(entryOutcome(entry({ verdict: 'supports', found: true }))).toBe('supports')
    expect(entryOutcome(entry({ verdict: 'supports', found: false }))).toBe('no_evidence')
    expect(entryOutcome(entry({ verdict: 'not_found' }))).toBe('not_found')
    expect(entryOutcome(entry({ reason: 'no_text' }))).toBe('unverified')
    expect(weakestOutcome(['supports', 'partial'])).toBe('partial')
    expect(weakestOutcome(['supports', 'does_not_support', 'unverified'])).toBe('does_not_support')
  })

  it('counts pairs, evidence not found among the unverified, and exports the report in Markdown', () => {
    const sentences: CiteCheckResult['sentences'] = [
      {
        start: 0,
        end: 10,
        text: 'A  claim\nhere.',
        citations: [{ start: 2, end: 8, keys: ['a', 'b'] }],
        entries: [
          entry({ key: 'a', verdict: 'supports', found: true, quote: 'the\nquote', page: 3, note: 'Fits.' }),
          entry({ key: 'b', verdict: 'partial', found: false, quote: 'invented' })
        ]
      },
      { start: 11, end: 20, text: 'Other.', citations: [], entries: [entry({ key: 'c', reason: 'unknown' })] }
    ]
    const counts = checkCounts(sentences)
    expect(counts).toEqual({ supports: 1, partial: 0, does_not_support: 0, not_found: 0, unverified: 2 })
    const result: CiteCheckResult = { format: 'org', sentences, counts, batches: 1, checkedBatches: 1, costUsd: 0.1, model: 'm', stopped: false, error: null, dropped: 0 }
    const md = citeCheckMarkdown(result, {
      title: 'Report',
      summary: (c) => `${c.supports} ok`,
      outcome: (o) => o.toUpperCase(),
      reason: (r) => `why ${r}`,
      page: (p) => `p. ${p}`,
      ended: null
    })
    expect(md).toBe(
      [
        '# Report',
        '',
        '1 ok',
        '',
        '## 1. A claim here.',
        '',
        '- **a**: SUPPORTS',
        '  > "the quote" (p. 3)',
        '  Fits.',
        '- **b**: NO_EVIDENCE',
        '  > "invented"',
        '',
        '## 2. Other.',
        '',
        '- **c**: UNVERIFIED (why unknown)',
        ''
      ].join('\n')
    )
  })
})
