import { describe, expect, it } from 'vitest'
import { bibType, buildFallbackEntry, buildOnlineEntry, escapeLatex, rekeyBibtex, setBibFields } from '../../../src/main/ingest/bibtex'

// Shapes returned by doi.org content negotiation: Crossref (leading space, one line) and DataCite (URL as key).
const CROSSREF = ' @inproceedings{He_2017, title={Drain: An Online Log Parsing Approach with Fixed Depth Tree}, year={2017} }'
const DATACITE = '@misc{https://doi.org/10.48550/arxiv.2008.06448,\n  title = {Loghub},\n  year = {2020}\n}'

describe('rekeyBibtex', () => {
  it('replaces the key of a Crossref entry', () => {
    expect(rekeyBibtex(CROSSREF, 'he2017drain')).toMatch(/^@inproceedings\{he2017drain, title=/)
  })

  it('replaces a DataCite URL key', () => {
    expect(rekeyBibtex(DATACITE, 'zhu2020loghub')).toMatch(/^@misc\{zhu2020loghub,\n/)
  })

  it('rejects text that is not an entry', () => {
    expect(() => rekeyBibtex('not bibtex', 'k')).toThrow()
  })
})

describe('escapeLatex', () => {
  it('escapes LaTeX specials and keeps accented letters as UTF-8', () => {
    expect(escapeLatex('Anonimización & logs: 100% {safe} $x_1$ #2 ~ ^')).toBe(
      'Anonimización \\& logs: 100\\% \\{safe\\} \\$x\\_1\\$ \\#2 \\textasciitilde{} \\textasciicircum{}'
    )
  })
})

describe('buildOnlineEntry', () => {
  it('builds a biblatex @online entry for grey literature', () => {
    const entry = buildOnlineEntry({
      key: 'acmeengineering2024database',
      title: 'Database outage postmortem',
      authors: [{ family: 'Jane Roe' }],
      site: 'Acme Engineering',
      date: '2024-03-01',
      url: 'https://eng.acme.test/posts/outage?a=1&b=2',
      urldate: '2026-10-07'
    })
    expect(entry).toBe(
      [
        '@online{acmeengineering2024database,',
        '  author = {{Jane Roe}},',
        '  title = {Database outage postmortem},',
        '  organization = {Acme Engineering},',
        '  date = {2024-03-01},',
        '  url = {https://eng.acme.test/posts/outage?a=1&b=2},',
        '  urldate = {2026-10-07}',
        '}'
      ].join('\n')
    )
  })
})

describe('buildFallbackEntry', () => {
  it('builds an arXiv preprint entry', () => {
    const entry = buildFallbackEntry({ key: 'zhu2020loghub', kind: 'preprint', title: 'Loghub', authors: [{ family: 'Zhu', given: 'Jieming' }], year: 2020, arxiv: '2008.06448' })
    expect(entry).toContain('@misc{zhu2020loghub,')
    expect(entry).toContain('author = {Zhu, Jieming}')
    expect(entry).toContain('eprint = {2008.06448}')
    expect(entry).toContain('archiveprefix = {arXiv}')
  })

  it('puts the venue in booktitle for conference papers', () => {
    const entry = buildFallbackEntry({ key: 'he2017drain', kind: 'conference', title: 'Drain', authors: [], year: 2017, venue: 'ICWS' })
    expect(entry).toContain('@inproceedings{he2017drain,')
    expect(entry).toContain('booktitle = {ICWS}')
    expect(entry).not.toContain('author')
  })
})

describe('setBibFields', () => {
  it('replaces, adds and removes fields; the key and every other field stay as written', () => {
    const entry = ' @inproceedings{He_2017, title={Drain: {An} Online Log Parser}, pages = "1--8", year=2017, month = jun, publisher={IEEE} }'
    const next = setBibFields(entry, { TITLE: { value: 'Drain & Co' }, year: null, booktitle: { value: 'ICWS' } })
    expect(next).toBe(
      '@inproceedings{He_2017,\n  title = {Drain \\& Co},\n  pages = "1--8",\n  month = jun,\n  publisher = {IEEE},\n  booktitle = {ICWS}\n}'
    )
    expect(bibType(next)).toBe('inproceedings')
  })

  it('keeps raw values unescaped, and concatenations as written', () => {
    const entry = '@online{acme2024logs,\n  title = {Logs},\n  note = "a" # b,\n  url = {https://acme.test/x}\n}'
    expect(setBibFields(entry, { url: { value: 'https://acme.test/y_z?a=1', raw: true } })).toBe(
      '@online{acme2024logs,\n  title = {Logs},\n  note = "a" # b,\n  url = {https://acme.test/y_z?a=1}\n}'
    )
  })

  it('refuses text that is not an entry', () => {
    expect(() => setBibFields('title = {x}', { title: null })).toThrow()
    expect(bibType('nope')).toBeNull()
  })
})

describe('normalizeBibMonth', () => {
  it('turns month names, abbreviations and numbers into the standard macro', async () => {
    const { normalizeBibMonth } = await import('../../../src/main/ingest/bibtex')
    const cases: [string, string][] = [
      ['@inproceedings{k, title={T}, year={2017}, month=June, pages={33–40} }', '@inproceedings{k, title={T}, year={2017}, month=jun, pages={33–40} }'],
      ['@article{k, month=Oct, year={2026}}', '@article{k, month=oct, year={2026}}'],
      ['@article{k,\n  month = {September},\n}', '@article{k,\n  month = sep,\n}'],
      ['@article{k, month = "sept.", year=2020}', '@article{k, month = sep, year=2020}'],
      ['@article{k, month = {6}}', '@article{k, month = jun}'],
      ['@article{k, month = {junio}}', '@article{k, month = jun}'],
      ['@article{k, month = jun}', '@article{k, month = jun}']
    ]
    for (const [input, expected] of cases) expect(normalizeBibMonth(input)).toBe(expected)
  })

  it('leaves what it cannot read, and other fields named like month, alone', async () => {
    const { normalizeBibMonth } = await import('../../../src/main/ingest/bibtex')
    expect(normalizeBibMonth('@article{k, month = {Spring}}')).toBe('@article{k, month = {Spring}}')
    expect(normalizeBibMonth('@article{k, month = {13}}')).toBe('@article{k, month = {13}}')
    expect(normalizeBibMonth('@article{k, bimonth = {June}}')).toBe('@article{k, bimonth = {June}}')
    expect(normalizeBibMonth('@article{k, title={x}}')).toBe('@article{k, title={x}}')
  })

  it('applies through rekeyBibtex, so library.bib and every export get it', async () => {
    const { rekeyBibtex } = await import('../../../src/main/ingest/bibtex')
    expect(rekeyBibtex('@article{old, month=June}', 'new2024')).toBe('@article{new2024, month=jun}')
  })
})
