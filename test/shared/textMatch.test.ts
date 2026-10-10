import { describe, expect, it } from 'vitest'
import { findInNormalized, locateInOriginal, normalizeForMatch, normalizeWithMap, quoteFound } from '../../src/shared/textMatch'

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

describe('normalizeWithMap', () => {
  const cases = [
    'The ﬁne-tuned  "BERT"\nmodel — ok',
    'detec-\ntion of PII',
    'detec- tion of PII',
    'For detection, we fine-tune a BERT model on 12k annotated log lines collected from three services.',
    '  leading and trailing   spaces  ',
    'Línea con acentos: áéíóú, ñ, and "curly" quotes',
    '',
  ]

  it('produces exactly the same text as normalizeForMatch', () => {
    for (const s of cases) {
      expect(normalizeWithMap(s).text).toBe(normalizeForMatch(s))
    }
  })

  it('maps each normalized index back to a valid original index', () => {
    const s = 'For detection, we fine-\ntune a BERT model on 12k log lines.'
    const { text, map } = normalizeWithMap(s)
    expect(map.length).toBe(text.length)
    for (const idx of map) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThanOrEqual(s.length)
    }
    // The map is non-decreasing (normalized text preserves original order).
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1])
  })

  it('maps a diacritic/case-folded character back to its original position', () => {
    const s = 'Él vino'
    const { text, map } = normalizeWithMap(s)
    expect(text).toBe('él vino')
    const eIdx = text.indexOf('é')
    expect(s[map[eIdx]]).toBe('É')
  })
})

describe('locateInOriginal', () => {
  it('finds an exact quote and keeps original case, accents and punctuation', () => {
    const original = 'Para la detección, afinamos un modelo BERT con 12k líneas.'
    const r = locateInOriginal('afinamos un modelo BERT', original)
    expect(r).not.toBeNull()
    expect(original.slice(r!.start, r!.end)).toBe('afinamos un modelo BERT')
  })

  it('is case- and diacritic-insensitive on the quote side', () => {
    const original = 'Para la detección, AFINAMOS un MODELO Bert con 12k líneas.'
    const r = locateInOriginal('afinamos un modelo bert', original)
    expect(r).not.toBeNull()
    expect(original.slice(r!.start, r!.end)).toBe('AFINAMOS un MODELO Bert')
  })

  it('handles curly quotes and dash variants in the quote', () => {
    const original = 'The “fine-tuned” model — released last year.'
    const r = locateInOriginal("The 'fine-tuned' model - released last year", original)
    expect(r).not.toBeNull()
    expect(original.slice(r!.start, r!.end)).toBe('The “fine-tuned” model — released last year')
  })

  it('finds a quote spanning a hyphenated line break in the original', () => {
    const original = 'For detec-\ntion of PII we used a classifier.'
    const r = locateInOriginal('detection of PII', original)
    expect(r).not.toBeNull()
    expect(original.slice(r!.start, r!.end)).toBe('detec-\ntion of PII')
  })

  it('collapses multiple spaces and newlines when locating the quote', () => {
    const original = 'We   fine-tune\n\na BERT   model on logs.'
    const r = locateInOriginal('we fine-tune a BERT model', original)
    expect(r).not.toBeNull()
    expect(original.slice(r!.start, r!.end)).toBe('We   fine-tune\n\na BERT   model')
  })

  it('returns null when the quote is not found', () => {
    const original = 'We fine-tune a BERT model on logs.'
    expect(locateInOriginal('we train a GPT model on synthetic traces', original)).toBeNull()
  })
})
