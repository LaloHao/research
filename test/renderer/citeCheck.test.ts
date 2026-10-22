import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { checkPlanLines, endedLine, textSegments } from '../../src/renderer/lib/citeCheck'
import type { CheckEntry, CiteCheckPlan, CiteCheckResult } from '../../src/shared/writing/citeCheck'

const t = ((key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key)) as unknown as TFunction

const entry = (key: string, patch: Partial<CheckEntry>): CheckEntry => ({ key, verdict: null, reason: null, quote: null, page: null, found: false, note: null, ...patch })

function result(patch: Partial<CiteCheckResult> = {}): CiteCheckResult {
  return {
    format: 'latex',
    sentences: [
      {
        start: 0,
        end: 20,
        text: 'A \\cite{a,b} and \\cite{c}.',
        citations: [
          { start: 2, end: 12, keys: ['a', 'b'] },
          { start: 17, end: 25, keys: ['c'] }
        ],
        entries: [entry('a', { verdict: 'supports', found: true }), entry('b', { verdict: 'partial', found: true }), entry('c', { reason: 'no_text' })]
      }
    ],
    counts: { supports: 1, partial: 1, does_not_support: 0, not_found: 0, unverified: 1 },
    batches: 2,
    checkedBatches: 1,
    costUsd: 0.1,
    model: 'm',
    stopped: false,
    error: null,
    dropped: 0,
    ...patch
  }
}

describe('citation check view', () => {
  it('cuts the checked text into plain pieces and citations colored by their weakest outcome', () => {
    const text = 'A \\cite{a,b} and \\cite{c}.'
    expect(textSegments(text, result()).map((s) => [s.text, s.citation?.outcome ?? null, s.citation?.sentence ?? null])).toEqual([
      ['A ', null, null],
      ['\\cite{a,b}', 'partial', 0],
      [' and ', null, null],
      ['\\cite{c}', 'unverified', 0],
      ['.', null, null]
    ])
  })

  it('says why a check ended early', () => {
    expect(endedLine(t, result())).toBeNull()
    expect(endedLine(t, result({ stopped: true }))).toBe('writing.check.stopped {"done":1,"total":2}')
    expect(endedLine(t, result({ error: 'llm_quota' }))).toContain('writing.check.ended_early')
  })

  it('warns in the confirmation when the estimate exceeds the cap and lists what cannot be checked', () => {
    const plan: CiteCheckPlan = { estimateUsd: 1, capUsd: 1, monthSpentUsd: 2, monthCapUsd: null, perCallUsd: 0.2, sentences: 50, pairs: 60, batches: 5, unverifiable: 2, model: 'sonnet' }
    const lines = checkPlanLines(t, plan)
    expect(lines[0]).toBe('writing.check.confirm {"count":50,"pairs":60,"calls":5,"cost":"~$1.00"}')
    expect(lines).toContain('writing.check.unverifiable {"count":2}')
    expect(lines.some((l) => l.startsWith('writing.check.may_stop'))).toBe(false)
    expect(checkPlanLines(t, { ...plan, batches: 6 }).some((l) => l.startsWith('writing.check.may_stop'))).toBe(true)
  })
})
