import { describe, expect, it } from 'vitest'
import { applyMetadataEdit } from '../../../src/main/library/metadataEdit'
import { InvalidEdit } from '../../../src/main/summary/merge'
import { bibFields } from '../../../src/shared/writing/bibtex'
import { samplePaper } from '../../helpers/papers'

const WEB = samplePaper({
  id: 'towardsdatasciencendhow',
  kind: 'web',
  title: 'How to Validate OpenAI GPT Model Performance with Text Summarization',
  authors: [],
  year: undefined,
  venue: 'towardsdatascience.com',
  identifiers: { url: 'https://towardsdatascience.com/how-to-validate-298978fea764/' },
  bibtex:
    '@online{towardsdatasciencendhow,\n  title = {How to Validate OpenAI GPT Model Performance with Text Summarization},\n  organization = {towardsdatascience.com},\n  url = {https://towardsdatascience.com/how-to-validate-298978fea764/},\n  urldate = {2026-10-29}\n}',
  metadata_status: 'incomplete'
})

describe('applyMetadataEdit', () => {
  it('fills a web page: authors, date (and its year), site; the key and the access date stay', () => {
    const next = applyMetadataEdit(WEB, {
      authors: [{ family: 'Pérez', given: 'Ana' }, { family: 'Towards Data Science' }],
      date: '2023-03-14',
      venue: 'Towards Data Science'
    })
    expect(next).toMatchObject({ id: WEB.id, year: 2023, venue: 'Towards Data Science', metadata_status: 'complete' })
    const fields = bibFields(next.bibtex)
    expect(next.bibtex.startsWith('@online{towardsdatasciencendhow,')).toBe(true)
    expect(fields.get('author')).toBe('Pérez, Ana and {Towards Data Science}')
    expect(fields.get('date')).toBe('2023-03-14')
    expect(fields.has('year')).toBe(false)
    expect(fields.get('organization')).toBe('Towards Data Science')
    expect(fields.get('urldate')).toBe('2026-10-29')
  })

  it('edits a paper with publisher BibTeX in place: its venue field, title and URL', () => {
    const paper = samplePaper({ bibtex: '@article{he2017drain, title={Drain}, journal={Old}, volume={3}, year={2017} }' })
    const next = applyMetadataEdit(paper, { title: '  Drain:  a parser ', venue: 'TSE', url: 'https://acme.test/drain', year: 2018 })
    expect(next).toMatchObject({ title: 'Drain: a parser', venue: 'TSE', year: 2018, identifiers: { doi: '10.1109/icws.2017.13', url: 'https://acme.test/drain' } })
    expect([...bibFields(next.bibtex)]).toEqual([
      ['title', 'Drain: a parser'],
      ['journal', 'TSE'],
      ['volume', '3'],
      ['year', '2018'],
      ['url', 'https://acme.test/drain']
    ])
  })

  it('removes emptied fields, and a date of another year when the year changes', () => {
    const dated = applyMetadataEdit(WEB, { date: '2023-03' })
    const next = applyMetadataEdit(dated, { year: 2024, venue: null, url: null })
    expect(next.venue).toBeUndefined()
    expect(next.identifiers.url).toBeUndefined()
    const fields = bibFields(next.bibtex)
    expect(fields.get('year')).toBe('2024')
    expect(fields.has('date')).toBe(false)
    expect(fields.has('organization')).toBe(false)
    expect(fields.has('url')).toBe(false)
    expect(applyMetadataEdit(next, { year: null }).year).toBeUndefined()
  })

  it('rebuilds an entry it cannot read from the paper', () => {
    const next = applyMetadataEdit({ ...WEB, bibtex: 'garbage' }, { title: 'Fixed' })
    expect(next.bibtex).toMatch(/^@online\{towardsdatasciencendhow,/)
    expect(bibFields(next.bibtex).get('title')).toBe('Fixed')
  })

  it('refuses an empty title and a malformed date', () => {
    expect(() => applyMetadataEdit(WEB, { title: '   ' })).toThrow(InvalidEdit)
    expect(() => applyMetadataEdit(WEB, { date: '14/03/2023' })).toThrow(InvalidEdit)
  })
})
