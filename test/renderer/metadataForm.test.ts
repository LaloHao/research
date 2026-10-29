import { describe, expect, it } from 'vitest'
import { authorsText, editFromForm, formFromPaper, parseAuthors } from '../../src/renderer/lib/metadataForm'
import { samplePaper } from '../helpers/papers'

const WEB = samplePaper({
  id: 'acmendwhy',
  kind: 'web',
  title: 'Why Logs Matter',
  authors: [],
  year: undefined,
  venue: 'acme.test',
  identifiers: { url: 'https://acme.test/why-logs-matter' },
  bibtex: '@online{acmendwhy,\n  title = {Why Logs Matter},\n  date = {2024-05-02},\n  url = {https://acme.test/why-logs-matter}\n}'
})

describe('metadata form', () => {
  it('reads and writes authors one per line', () => {
    expect(parseAuthors('Roe, Jane\nJohn  Smith\n\nAcme\n{Data Team}')).toEqual([
      { family: 'Roe', given: 'Jane' },
      { family: 'Smith', given: 'John' },
      { family: 'Acme' },
      { family: 'Data Team' }
    ])
    expect(authorsText([{ family: 'Roe', given: 'Jane' }, { family: 'Acme' }])).toBe('Roe, Jane\nAcme')
  })

  it('starts from the paper, the date from its entry', () => {
    expect(formFromPaper(WEB)).toEqual({ title: 'Why Logs Matter', authors: '', year: '', date: '2024-05-02', venue: 'acme.test', url: 'https://acme.test/why-logs-matter' })
  })

  it('sends only what changed; an emptied field is removed', () => {
    const form = { ...formFromPaper(WEB), authors: 'Roe, Jane', venue: '  Acme   Blog ', url: '' }
    expect(editFromForm(WEB, form)).toEqual({ edit: { authors: [{ family: 'Roe', given: 'Jane' }], venue: 'Acme Blog', url: null } })
    expect(editFromForm(WEB, formFromPaper(WEB))).toEqual({ edit: {} })
    expect(editFromForm(WEB, { ...formFromPaper(WEB), date: '', year: '2023' })).toEqual({ edit: { date: null, year: 2023 } })
  })

  it('checks the title, year, date and URL', () => {
    const base = formFromPaper(WEB)
    expect(editFromForm(WEB, { ...base, title: ' ' })).toEqual({ error: 'title' })
    expect(editFromForm(WEB, { ...base, date: '', year: '23' })).toEqual({ error: 'year' })
    expect(editFromForm(WEB, { ...base, date: '2/5/2024' })).toEqual({ error: 'date' })
    expect(editFromForm(WEB, { ...base, url: 'acme.test' })).toEqual({ error: 'url' })
  })
})
