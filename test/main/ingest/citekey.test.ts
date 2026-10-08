import { describe, expect, it } from 'vitest'
import { asciiFold, baseCitekey, uniqueCitekey } from '../../../src/main/ingest/citekey'

describe('baseCitekey', () => {
  it('uses first author family + year + first significant title word', () => {
    expect(baseCitekey({ authors: [{ family: 'He', given: 'Pinjia' }], year: 2017, title: 'Drain: An Online Log Parsing Approach' })).toBe('he2017drain')
    expect(baseCitekey({ authors: [{ family: 'Zhu' }], year: 2020, title: 'Loghub: A Large Collection of System Log Datasets' })).toBe('zhu2020loghub')
  })

  it('skips stopwords and folds accents', () => {
    expect(baseCitekey({ authors: [{ family: 'Müller' }], year: 2021, title: 'Über die Anonymisierung' })).toBe('muller2021uber')
    expect(baseCitekey({ authors: [{ family: 'Pérez' }], year: 2024, title: 'The Art of Logging' })).toBe('perez2024art')
    expect(baseCitekey({ authors: [{ family: 'van der Berg' }], year: 2019, title: 'LLM-based triage' })).toBe('vanderberg2019llmbased')
  })

  it('falls back to the site name and "nd" for grey literature', () => {
    expect(baseCitekey({ authors: [], site: 'sre.google', title: 'Postmortem Culture: Learning from Failure' })).toBe('sregooglendpostmortem')
  })

  it('never starts with a digit and never ends up empty', () => {
    expect(baseCitekey({ authors: [{ family: '3M Company' }], year: 2020, title: '' })).toBe('mcompany2020')
    expect(baseCitekey({ authors: [], title: '!!!' })).toBe('anonnd')
  })
})

describe('uniqueCitekey', () => {
  it('adds a, b, … when the key is taken', () => {
    const taken = new Set(['he2017drain', 'he2017draina'])
    expect(uniqueCitekey('he2017drain', (id) => taken.has(id))).toBe('he2017drainb')
    expect(uniqueCitekey('zhu2020loghub', (id) => taken.has(id))).toBe('zhu2020loghub')
  })
})

describe('asciiFold', () => {
  it('folds characters NFKD does not decompose', () => {
    expect(asciiFold('Straße Øre Łódź Æther')).toBe('strasse ore lodz aether')
  })
})
