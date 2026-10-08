import { describe, expect, it } from 'vitest'
import { buildFallbackEntry, buildOnlineEntry, escapeLatex, rekeyBibtex } from '../../../src/main/ingest/bibtex'

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
