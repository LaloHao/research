import { describe, expect, it } from 'vitest'
import { findInNormalized, normalizeForMatch, quoteFound } from '../../src/shared/textMatch'

describe('normalizeForMatch', () => {
  it('folds ligatures, typographic quotes and dashes, whitespace and case', () => {
    expect(normalizeForMatch('The ﬁne-tuned  “BERT”\nmodel — ok')).toBe('the fine-tuned "bert" model - ok')
  })

  it('joins words split by a line-break hyphen', () => {
    expect(normalizeForMatch('detec-\ntion of PII')).toBe('detection of pii')
    expect(normalizeForMatch('detec- tion of PII')).toBe('detection of pii')
  })
})

describe('findInNormalized', () => {
  const text = normalizeForMatch('For detection, we fine-tune a BERT model on 12k annotated log lines collected from three services.')

  it('finds an exact quote', () => {
    const q = normalizeForMatch('we fine-tune a BERT model')
    const r = findInNormalized(q, text)
    expect(r?.score).toBe(1)
    expect(text.slice(r!.start, r!.end)).toBe(q)
  })

  it('tolerates a small difference', () => {
    const q = normalizeForMatch('we fine tune the BERT model on 12k annotated log lines')
    expect(findInNormalized(q, text)?.score).toBeGreaterThanOrEqual(0.85)
  })

  it('rejects an invented quote', () => {
    expect(findInNormalized(normalizeForMatch('we train a GPT model on synthetic traces'), text)).toBeNull()
  })

  it('matches a hyphenated quote word against a joined text word', () => {
    const q = normalizeForMatch('we fine-tune a BERT model')
    const joined = normalizeForMatch('For detection, we finetune a BERT model on 12k log lines.')
    expect(findInNormalized(q, joined)?.score).toBeGreaterThanOrEqual(0.85)
  })

  it('matches a joined quote word against a hyphenated text word', () => {
    const q = normalizeForMatch('we finetune a BERT model')
    expect(findInNormalized(q, text)?.score).toBeGreaterThanOrEqual(0.85)
  })

  it('still rejects an invented quote that only shares a merged pair with the text', () => {
    const q = normalizeForMatch('we use pre training on synthetic traces only')
    const unrelated = normalizeForMatch(
      'Researchers announced that the pretraining team expanded their computing budget for next quarter releases across multiple laboratories worldwide.',
    )
    expect(findInNormalized(q, unrelated)).toBeNull()
  })
})

describe('quoteFound', () => {
  it('normalizes both sides', () => {
    expect(quoteFound('We ﬁne-tune a BERT model', 'For detection, we fine-\ntune a BERT model on logs')).toBe(true)
  })
})
