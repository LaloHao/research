import { describe, expect, it } from 'vitest'
import { arxivDoi, arxivFromDoi, findIdentifiersInText, normalizeIsbn, parseInput } from '../../../src/main/ingest/identifiers'

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

  it('recognizes OpenAlex work ids and URLs', () => {
    expect(parseInput('W2132031035')).toEqual({ kind: 'openalex', openalex: 'W2132031035' })
    expect(parseInput('https://openalex.org/W2132031035')).toEqual({ kind: 'openalex', openalex: 'W2132031035' })
    expect(parseInput('https://api.openalex.org/works/w2132031035')).toEqual({ kind: 'openalex', openalex: 'W2132031035' })
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

describe('normalizeIsbn', () => {
  it.each([
    ['978-1-4919-2912-4', '9781491929124'],
    ['ISBN 978 1 4919 2912 4', '9781491929124'],
    ['ISBN-13: 9781491929124', '9781491929124'],
    ['149192912X', '9781491929124'],
    ['ISBN-10 1-4919-2912-x', '9781491929124'],
    ['0-262-03384-4', '9780262033848']
  ])('%s → %s', (raw, isbn) => expect(normalizeIsbn(raw)).toBe(isbn))

  it.each(['978-1-4919-2912-5', '1491929121', '12345', '9771491929124', '2008.06448'])('rejects %s', (raw) => expect(normalizeIsbn(raw)).toBeNull())

  it('is what «Agregar» reads from an ISBN, before a DOI or a URL', () => {
    expect(parseInput('978-1-4919-2912-4')).toEqual({ kind: 'isbn', isbn: '9781491929124' })
    expect(parseInput('ISBN 149192912X')).toEqual({ kind: 'isbn', isbn: '9781491929124' })
    expect(parseInput('978-1-4919-2912-5')).toEqual({ kind: 'invalid' })
    expect(parseInput('2008.06448')).toEqual({ kind: 'arxiv', arxiv: '2008.06448' })
  })
})
