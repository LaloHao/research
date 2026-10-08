import { describe, expect, it } from 'vitest'
import { arxivDoi, arxivFromDoi, findIdentifiersInText, parseInput } from '../../../src/main/ingest/identifiers'

describe('parseInput', () => {
  it.each([
    ['10.1109/ICWS.2017.13', { kind: 'doi', doi: '10.1109/icws.2017.13' }],
    ['doi:10.1145/3368089.3409741', { kind: 'doi', doi: '10.1145/3368089.3409741' }],
    ['https://doi.org/10.1109/ICWS.2017.13', { kind: 'doi', doi: '10.1109/icws.2017.13' }],
    ['https://dl.acm.org/doi/10.1145/3368089.3409741', { kind: 'doi', doi: '10.1145/3368089.3409741' }],
    ['arXiv:2008.06448v2', { kind: 'arxiv', arxiv: '2008.06448' }],
    ['2008.06448', { kind: 'arxiv', arxiv: '2008.06448' }],
    ['cs/0112017', { kind: 'arxiv', arxiv: 'cs/0112017' }],
    ['https://arxiv.org/abs/2008.06448', { kind: 'arxiv', arxiv: '2008.06448' }],
    ['https://arxiv.org/pdf/2008.06448v1', { kind: 'arxiv', arxiv: '2008.06448' }],
    ['https://sre.google/sre-book/postmortem-culture/', { kind: 'url', url: 'https://sre.google/sre-book/postmortem-culture/' }],
    ['  ', { kind: 'invalid' }],
    ['hello world', { kind: 'invalid' }]
  ])('%s', (input, expected) => {
    expect(parseInput(input)).toEqual(expected)
  })
})

describe('arXiv DOIs', () => {
  it('round-trips between an arXiv id and its DataCite DOI', () => {
    expect(arxivDoi('2008.06448')).toBe('10.48550/arxiv.2008.06448')
    expect(arxivFromDoi('10.48550/ARXIV.2008.06448')).toBe('2008.06448')
    expect(arxivFromDoi('10.1109/icws.2017.13')).toBeNull()
  })
})

describe('findIdentifiersInText', () => {
  it('finds a DOI and strips trailing punctuation', () => {
    expect(findIdentifiersInText('Some text\nDOI: 10.1109/ICWS.2017.13.\nMore')).toEqual({ doi: '10.1109/icws.2017.13' })
  })

  it('finds an arXiv id stamped in the margin', () => {
    expect(findIdentifiersInText('arXiv:2008.06448v3 [cs.SE] 5 Aug 2020')).toEqual({ arxiv: '2008.06448' })
  })

  it('returns nothing when there is nothing', () => {
    expect(findIdentifiersInText('no identifiers here')).toEqual({})
  })
})
