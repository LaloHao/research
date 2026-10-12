import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { latexToText, parseBibtex, splitBibNames } from '../../../src/main/mapping/importers/bibtex'
import { parseCsv } from '../../../src/main/mapping/importers/csv'
import { decodeExport, detectFormat, MAX_EXPORT_RECORDS, parseExport } from '../../../src/main/mapping/importers/importFile'
import { parseName } from '../../../src/main/mapping/importers/names'
import { parseRis } from '../../../src/main/mapping/importers/ris'

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/mapping/${name}`, import.meta.url), 'utf8')

describe('parseExport', () => {
  it('reads a Scopus CSV: full author names, lowercase DOIs, kinds, no placeholder abstract, and skips an entry without a title', () => {
    const out = parseExport('scopus.csv', fixture('scopus.csv'))!
    expect(out.format).toBe('csv_scopus')
    expect(out.records).toHaveLength(4)
    expect(out.skipped).toBe(1)
    expect(out.records[0]).toEqual({
      title: 'Drain: An Online Log Parsing Approach with Fixed Depth Tree',
      authors: [
        { family: 'He', given: 'Pinjia' },
        { family: 'Zhu', given: 'Jieming' },
        { family: 'Zheng', given: 'Zibin' },
        { family: 'Lyu', given: 'Michael R.' }
      ],
      year: 2017,
      venue: 'Proceedings - 2017 IEEE 24th International Conference on Web Services, ICWS 2017',
      abstract: expect.stringContaining('walks a tree of fixed depth'),
      kind: 'conference',
      identifiers: { doi: '10.1109/icws.2017.13' }
    })
    expect(out.records[2].abstract).toBe(
      'Many log parsers exist, but they are rarely compared on the same data. This study benchmarks thirteen parsers on sixteen datasets and reports their accuracy, robustness and efficiency, "as used in practice".'
    )
    expect(out.records[3].abstract).toBeNull()
  })

  it('reads an IEEE Xplore CSV, with initials first in the names', () => {
    const out = parseExport('export2026.10.12-10.00.00.csv', fixture('ieee.csv'))!
    expect(out.format).toBe('csv_ieee')
    expect(out.records.map((r) => r.identifiers.doi)).toEqual(['10.1109/icws.2017.13', '10.1109/issre.2016.21', '10.1109/dsn.2016.66'])
    expect(out.records[0]).toMatchObject({
      authors: [{ family: 'He', given: 'P.' }, { family: 'Zhu', given: 'J.' }, { family: 'Zheng', given: 'Z.' }, { family: 'Lyu', given: 'M. R.' }],
      venue: '2017 IEEE International Conference on Web Services (ICWS)',
      year: 2017,
      kind: 'conference'
    })
  })

  it('reads an ACM Digital Library BibTeX export: macros, concatenation and nested braces', () => {
    const out = parseExport('acm.bib', fixture('acm.bib'))!
    expect(out).toMatchObject({ format: 'bibtex', skipped: 0 })
    expect(out.records.map((r) => r.title)).toEqual([
      'Robust Log-Based Anomaly Detection on Unstable Log Data',
      'DeepLog: Anomaly Detection and Diagnosis from System Logs through Deep Learning'
    ])
    expect(out.records[0]).toMatchObject({
      authors: [{ family: 'Zhang', given: 'Xu' }, { family: 'Xu', given: 'Yong' }, { family: 'Lin', given: 'Qingwei' }, { family: 'Qiao', given: 'Bo' }],
      year: 2019,
      kind: 'conference',
      identifiers: { doi: '10.1145/3338906.3338931' },
      abstract: expect.stringContaining('so that anomaly detection keeps working')
    })
    expect(out.records[1].abstract).toBe(
      'A system log records events as they happen. We model a log as a sequence of words with a recurrent network that learns normal patterns and flags deviations.'
    )
  })

  it('reads a Web of Science RIS export, joining the lines an abstract continues on', () => {
    const out = parseExport('savedrecs.ris', fixture('wos.ris'))!
    expect(out).toMatchObject({ format: 'ris', skipped: 0 })
    expect(out.records).toHaveLength(3)
    expect(out.records[0]).toMatchObject({
      authors: [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }, { family: 'Zheng', given: 'Zibin' }, { family: 'Lyu', given: 'Michael R.' }],
      abstract: 'Logs record what a system does at runtime, and most log analysis starts by turning raw messages into templates.',
      kind: 'conference',
      identifiers: { doi: '10.1109/icws.2017.13' }
    })
    expect(out.records[2]).toMatchObject({ kind: 'article', venue: 'ACM COMPUTING SURVEYS', year: 2021, identifiers: { doi: '10.1145/3460345' } })
  })

  it('reads any CSV with recognizable columns, taking an arXiv id from an arXiv DOI', () => {
    const out = parseExport('mine.csv', fixture('generic.csv'))!
    expect(out.format).toBe('csv')
    expect(out.records[0]).toMatchObject({
      year: 2020,
      venue: 'arXiv',
      identifiers: { doi: '10.48550/arxiv.2008.06448', arxiv: '2008.06448' },
      authors: [{ family: 'He', given: 'Shilin' }, { family: 'Zhu', given: 'Jieming' }, { family: 'He', given: 'Pinjia' }, { family: 'Lyu', given: 'Michael R.' }]
    })
    expect(out.records[1]).toMatchObject({ identifiers: {}, abstract: null, authors: [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }] })
  })

  it('tells the format by extension or by content, and reads nothing from other files', () => {
    expect(detectFormat('refs.bibtex', '')).toBe('bibtex')
    expect(detectFormat('export.txt', '\n@article{a, title = {T}}')).toBe('bibtex')
    expect(detectFormat('export.txt', 'TY  - JOUR\nTI  - T\nER  - ')).toBe('ris')
    expect(detectFormat('notes.txt', 'hello')).toBeNull()
    expect(parseExport('notes.txt', 'hello')).toBeNull()
    expect(parseExport('empty.bib', '')).toEqual({ format: 'bibtex', records: [], skipped: 0 })
  })
})

describe('parseCsv', () => {
  it('handles a BOM, CRLF, quoted commas, doubled quotes, line breaks, blank lines and short rows', () => {
    const text = '\uFEFFTitle,Year\r\n"A, B ""C""",2020\r\n\r\n"Two\nlines"\r\n'
    expect(parseCsv(text)).toEqual({
      header: ['Title', 'Year'],
      rows: [
        { Title: 'A, B "C"', Year: '2020' },
        { Title: 'Two\nlines', Year: '' }
      ]
    })
  })
})

describe('parseBibtex', () => {
  it('reads braces, quotes, parentheses, @string macros joined with #, and skips comments and entries without a key', () => {
    const text = String.raw`@string{conf = "Proc. of "}
@comment{ignore {this}}
@article(key1, title = "A {Nested {Title}}", booktitle = conf # {ICWS}, year = 2017)
@misc{no key here}
@misc{key2, title = {Preprint}, eprint = {2008.06448}, archiveprefix = {arXiv}}`
    const entries = parseBibtex(text)
    expect(entries.map((e) => e.key)).toEqual(['key1', 'key2'])
    expect(entries[0].fields).toEqual({ title: 'A {Nested {Title}}', booktitle: 'Proc. of ICWS', year: '2017' })
    expect(parseExport('x.bib', text)!.records[1]).toMatchObject({ kind: 'preprint', identifiers: { arxiv: '2008.06448' } })
  })

  it('decodes LaTeX accents and commands, and keeps braced names as one family name', () => {
    expect(latexToText(String.raw`Sch{\"o}nberg, Garc{\'\i}a, {\c{C}}elik, \ss{}e and \textit{italic} \& more`)).toBe('Schönberg, García, Çelik, ße and italic & more')
    expect(splitBibNames('{IEEE Computer Society} and Doe, Jane and {Smith and Sons}')).toEqual(['{IEEE Computer Society}', 'Doe, Jane', '{Smith and Sons}'])
    const out = parseExport('x.bib', '@book{k, title = {T}, author = {{IEEE Computer Society} and Doe, Jane}}')!
    expect(out.records[0].authors).toEqual([{ family: 'IEEE Computer Society' }, { family: 'Doe', given: 'Jane' }])
  })
})

describe('parseRis and names', () => {
  it('keeps every value of a repeated tag and ignores lines outside an entry', () => {
    expect(parseRis('stray line\nTY  - JOUR\nAU  - A, B\nAU  - C, D\nER  -\n')).toEqual([{ TY: ['JOUR'], AU: ['A, B', 'C, D'] }])
  })

  it('reads the name shapes of each export', () => {
    expect(parseName('He, Pinjia (57190000001)')).toEqual({ family: 'He', given: 'Pinjia' })
    expect(parseName('Lyu M.R.')).toEqual({ family: 'Lyu', given: 'M.R.' })
    expect(parseName('M. R. Lyu')).toEqual({ family: 'Lyu', given: 'M. R.' })
    expect(parseName('Van der Berg J.-L.')).toEqual({ family: 'Van der Berg', given: 'J.-L.' })
    expect(parseName('Anonymous')).toEqual({ family: 'Anonymous' })
    expect(parseName('  ')).toBeNull()
  })
})

/** Runs `fn` and fails when it takes longer than `ms`: a parser that went quadratic shows here, not as a frozen app. */
function fast<T>(fn: () => T, ms = 3000): T {
  const start = performance.now()
  const out = fn()
  expect(performance.now() - start).toBeLessThan(ms)
  return out
}

describe('hostile and malformed input', () => {
  it('BibTeX: an unbalanced entry ends where the next line starts an entry, and thousands of them stay linear', () => {
    const out = parseExport('x.bib', '@article{a, title = {Broken {title}\n@article{b, title = {Fine}}\n')!
    expect(out.records.map((r) => r.title)).toEqual(['Broken title', 'Fine'])
    const many = fast(() => parseExport('x.bib', '@article{k, title = {x\n'.repeat(40_000)))!
    expect(many.skipped).toBe(0)
    expect(many.records).toHaveLength(40_000)
    expect(fast(() => parseExport('x.bib', '@article{k, title = {' + 'x'.repeat(5_000_000)))!.records[0].title).toHaveLength(1000)
  })

  it('BibTeX: macros that double themselves, long # chains and broken fields stay bounded', () => {
    let text = '@string{m0 = "xxxxxxxxxx"}\n'
    for (let k = 1; k <= 40; k++) text += `@string{m${k} = m${k - 1} # m${k - 1}}\n`
    text += '@misc{k, title = m40, junk without equals, year = 2020, abstract = ' + Array(200_000).fill('"ab"').join(' # ') + '}\n'
    // The doubling spends the file's expansion budget, so the last macros expand to '' and the entry has no title.
    const out = fast(() => parseExport('x.bib', text))!
    expect(out).toMatchObject({ records: [], skipped: 1 })
    const fields = parseBibtex(text)[0].fields
    expect(fields.year).toBe('2020')
    expect(fields.abstract.length).toBeLessThanOrEqual(100_000)
  })

  it('BibTeX: long runs of whitespace, commas, accents and «and» do not hang, and field names cannot reach the prototype', () => {
    const spaces = ' '.repeat(30_000)
    const text =
      `@misc{k, constructor = {c}, toString = {s}, title = {\\'${spaces}e and ${spaces}x}, ` +
      `author = {A${spaces}and B and ${'x and '.repeat(200_000)}}, doi = {10.1/${'.'.repeat(1_000_000)}}, ` +
      `url = {https://example.org/%E0%A4%A}, note = {${','.repeat(1_000_000)}}}`
    const out = fast(() => parseExport('x.bib', text))!
    expect(out.records).toHaveLength(1)
    expect(out.records[0].title).toBe('é and x')
    expect(out.records[0].authors.length).toBeLessThanOrEqual(500)
    expect(out.records[0].authors.slice(0, 2)).toEqual([{ family: 'A' }, { family: 'B' }])
    expect(out.records[0].identifiers).toEqual({})
    expect(fast(() => parseBibtex(`@misc{k, ${', '.repeat(1_000_000)}title = {T}}`))[0].fields).toEqual({ title: 'T' })
  })

  it('RIS: a BOM, CRLF, lone CR, long whitespace runs and an entry the file leaves open', () => {
    const text = '\uFEFFTY  - JOUR\r\nTI  - One\r\nER  - \r\n' + 'TY  - JOUR\rTI  - Two\rAB  - a' + ' '.repeat(50_000) + 'b\r'
    const out = fast(() => parseExport('x.ris', text))!
    expect(out.records.map((r) => [r.title, r.abstract])).toEqual([
      ['One', null],
      ['Two', 'a b']
    ])
    const long = fast(() => parseRis('TY  - JOUR\nAB  - x\n' + '      more words\n'.repeat(300_000)))
    expect(long[0].AB[0].length).toBeLessThanOrEqual(100_000)
  })

  it('CSV: an unclosed quote stops at its line, and ; or tab delimiters are recognized', () => {
    expect(parseCsv('Title,Year\n"Broken,2020\nOk,2021\n').rows).toEqual([
      { Title: '"Broken', Year: '2020' },
      { Title: 'Ok', Year: '2021' }
    ])
    expect(parseCsv('Title;Year\r\n"A; B";2020\r\n')).toEqual({ header: ['Title', 'Year'], rows: [{ Title: 'A; B', Year: '2020' }] })
    expect(parseCsv('Title\tYear\nA\t2020\n').rows).toEqual([{ Title: 'A', Year: '2020' }])
    const paired = fast(() => parseCsv('Title\n' + '"x\n'.repeat(1_000_000))).rows
    expect(paired).toHaveLength(500_000)
    expect(paired[0]).toEqual({ Title: 'x\nx' })
  })

  it('CSV: formula-like cells are plain text, and spreadsheet-guarded values are unwrapped', () => {
    const text = 'title,doi,year,authors\n"=HYPERLINK(""http://x"",""t"")","=""10.1109/ICWS.2017.13""",+2020,"@SUM(A1); -2+3"\n@SUM(1),-x,=1+1,\n'
    const out = parseExport('f.csv', text)!
    expect(out.records[0]).toMatchObject({
      title: '=HYPERLINK("http://x","t")',
      identifiers: { doi: '10.1109/icws.2017.13' },
      year: 2020,
      authors: [{ family: '@SUM(A1)' }, { family: '-2+3' }]
    })
    expect(out.records[1]).toMatchObject({ title: '@SUM(1)', identifiers: {}, year: null })
  })

  it('CSV: a huge header, quotes inside unquoted cells, huge cells and too many rows stay bounded', () => {
    expect(fast(() => parseExport('f.csv', ','.repeat(1_000_000) + 'title\n' + 'x\n'.repeat(1000)))).toMatchObject({ records: [], skipped: 1000 })
    const quotes = fast(() => parseExport('f.csv', 'title\n' + 'a"'.repeat(1_000_000)))!
    expect(quotes.records[0].title).toHaveLength(1000)
    const rows = fast(() => parseExport('f.csv', 'title,abstract\n' + `x,${'y'.repeat(100)}\n`.repeat(MAX_EXPORT_RECORDS + 10)))!
    expect(rows.records).toHaveLength(MAX_EXPORT_RECORDS)
    expect(rows.truncated).toBe(true)
  })

  it('reads nothing from binary or oversized text, and control characters never reach a record', () => {
    expect(parseExport('f.csv', 'title\n\u0000\u0001binary')).toBeNull()
    expect(parseExport('f.csv', 'x'.repeat(20 * 1024 * 1024 + 1))).toBeNull()
    expect(parseExport('f.csv', 'title\nA\u0007B\u001b C\n')!.records[0].title).toBe('AB C')
  })

  it('decodes UTF-8 with or without BOM, UTF-16 with or without BOM, and Latin-1', () => {
    expect(decodeExport(Buffer.from('\uFEFFtitle\nÉcole', 'utf8'))).toBe('title\nÉcole')
    expect(decodeExport(Buffer.from('title\nÉcole', 'utf8'))).toBe('title\nÉcole')
    expect(decodeExport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('TY  - JOUR\nTI  - Ñu', 'utf16le')]))).toBe('TY  - JOUR\nTI  - Ñu')
    const be = Buffer.from('TY  - JOUR', 'utf16le').swap16()
    expect(decodeExport(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('TY  - JOUR')
    expect(decodeExport(be)).toBe('TY  - JOUR')
    expect(decodeExport(Buffer.from('title,year\nab', 'utf16le'))).toBe('title,year\nab')
    expect(decodeExport(new Uint8Array([0x74, 0x0a, 0xc9, 0x96, 0xfc]))).toBe('t\nÉ–ü')
    expect(decodeExport(new Uint8Array([0x80, 0xe9]))).toBe('€é')
    expect(decodeExport(new Uint8Array())).toBe('')
  })

  it('text helpers stay linear on long runs of blanks, commas and backslashes', () => {
    const blanks = ' '.repeat(1_000_000)
    expect(fast(() => latexToText(`\\'${blanks}\\c${blanks}{x`))).toBe("\\' x")
    expect(fast(() => splitBibNames(`a${blanks}b${blanks}and${blanks}c`))).toHaveLength(2)
    expect(fast(() => latexToText(`$${'a\\b'.repeat(300_000)}${'$x'.repeat(300_000)}`)).length).toBeGreaterThan(0)
    expect(fast(() => parseName(`${','.repeat(1_000_000)}x`))).toBeNull()
    expect(fast(() => parseRis(`TY  - JOUR\nTI  - a${blanks}b\n`))[0].TI[0].length).toBeLessThanOrEqual(100_000)
    expect(fast(() => parseCsv(`t\n${'x"'.repeat(1_000_000)}`)).rows).toHaveLength(1)
  })

  it('never throws on random or mangled input', () => {
    let seed = 42
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    const alphabet = '@{}()"\\,;=#%\n\r\t TYAUERDOI-_.:/0123456789abcxyzé\u0000\uFEFF\uD800'
    const sources = ['scopus.csv', 'ieee.csv', 'generic.csv', 'acm.bib', 'wos.ris'].map(fixture)
    for (let n = 0; n < 400; n++) {
      let text: string
      if (n % 2 === 0) {
        text = Array.from({ length: rand(400) }, () => alphabet[rand(alphabet.length)]).join('')
      } else {
        text = sources[rand(sources.length)]
        for (let k = 0; k < 5; k++) {
          const at = rand(text.length + 1)
          text = rand(2) === 0 ? text.slice(0, at) + text.slice(at + rand(50)) : text.slice(0, at) + alphabet[rand(alphabet.length)].repeat(rand(5) + 1) + text.slice(at)
        }
      }
      const binary = text.slice(0, 4000).includes('\u0000')
      for (const name of ['f.bib', 'f.ris', 'f.csv', 'f.txt']) {
        const out = parseExport(name, text)
        if (!binary && name !== 'f.txt') expect(out, `${name} #${n}`).not.toBeNull()
        for (const r of out?.records ?? []) {
          expect(r.title.trim()).not.toBe('')
          for (const a of r.authors) expect(a.family.trim()).not.toBe('')
        }
      }
      expect(() => parseCsv(text)).not.toThrow()
      expect(() => parseRis(text)).not.toThrow()
      expect(() => parseBibtex(text)).not.toThrow()
      expect(() => latexToText(text)).not.toThrow()
      expect(() => splitBibNames(text)).not.toThrow()
      expect(() => parseName(text)).not.toThrow()
    }
  })
})

describe('fix round 1', () => {
  it('BibTeX: one big macro referenced by every field of many entries stays within a per-file expansion budget', () => {
    const big = 'x'.repeat(100_000)
    const text = `@string{big = {${big}}}\n` + '@a{k,title=big,abstract=big,journal=big,booktitle=big,author=big,doi=big,url=big}\n'.repeat(20_000)
    const out = fast(() => parseExport('x.bib', text), 5000)!
    const total = out.records.reduce((n, r) => n + r.title.length + (r.abstract?.length ?? 0) + (r.venue?.length ?? 0) + r.authors.reduce((m, a) => m + a.family.length, 0), 0)
    expect(total).toBeLessThan(4 * text.length)
    expect(out.records.length + out.skipped).toBe(20_000)
  })

  it('names: all-caps names and dotted initials first are not inverted; particles and Jr. stay with the family name', () => {
    expect(parseName('J. YU')).toEqual({ family: 'YU', given: 'J.' })
    expect(parseName('JOHN SMITH')).toEqual({ family: 'SMITH', given: 'JOHN' })
    expect(parseName('J.-L. Van der Berg')).toEqual({ family: 'Van der Berg', given: 'J.-L.' })
    expect(parseName('Zhu J')).toEqual({ family: 'Zhu', given: 'J' })
    expect(parseName('Ludwig van Beethoven')).toEqual({ family: 'van Beethoven', given: 'Ludwig' })
    expect(parseName('Smith, Jr., John')).toEqual({ family: 'Smith Jr.', given: 'John' })
    expect(parseExport('x.bib', '@misc{k, title={T}, author={Smith, Jr., John and Jean de la Fontaine}}')!.records[0].authors).toEqual([
      { family: 'Smith Jr.', given: 'John' },
      { family: 'de la Fontaine', given: 'Jean' }
    ])
  })

  it('generic CSV: comma-separated authors (Publish or Perish), Zotero and Lens columns, and Lens is not Scopus', () => {
    const pop = parseExport('pop.csv', 'Cites,Authors,Title,Year\n10,"P He, J Zhu, Z Zheng",Drain,2017\n1,"He, Pinjia, Zhu, Jieming",Other,2018\n')!
    expect(pop.records.map((r) => r.authors)).toEqual([
      [{ family: 'He', given: 'P' }, { family: 'Zhu', given: 'J' }, { family: 'Zheng', given: 'Z' }],
      [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }]
    ])
    const zotero = parseExport('zotero.csv', '"Key","Item Type","Publication Year","Author","Title","Publication Title","DOI","Url","Abstract Note"\n"K1","conferencePaper","2017","He, Pinjia; Zhu, Jieming","Drain","ICWS","10.1109/ICWS.2017.13","","Online parsing."\n"K2","bookSection","2019","Doe, J","Chap","Book","","https://arxiv.org/abs/2008.06448",""\n')!
    expect(zotero.records[0]).toMatchObject({ kind: 'conference', abstract: 'Online parsing.', venue: 'ICWS', authors: [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }] })
    expect(zotero.records[1]).toMatchObject({ kind: 'chapter', identifiers: { arxiv: '2008.06448' } })
    const lens = parseExport('lens.csv', 'Lens ID,Title,Publication Year,Publication Type,Source Title,Author/s,DOI,Abstract\n001,Drain,2017,conference proceedings article,ICWS,Pinjia He; Jieming Zhu,10.1109/ICWS.2017.13,Text.\n')!
    expect(lens.format).toBe('csv')
    expect(lens.records[0]).toMatchObject({ kind: 'conference', venue: 'ICWS', authors: [{ family: 'He', given: 'Pinjia' }, { family: 'Zhu', given: 'Jieming' }] })
  })

  it('RIS: a line or paragraph separator inside a value keeps its tag', () => {
    expect(parseExport('x.ris', 'TY  - JOUR\nTI  - a b c\nER  - \n')!.records[0].title).toBe('a b c')
  })

  it('decodeExport: a few stray bytes in UTF-8 keep the file UTF-8', () => {
    const bytes = Buffer.concat([Buffer.from('Schönberg and ', 'utf8'), Buffer.from([0xe9]), Buffer.from(' Müller', 'utf8')])
    expect(decodeExport(bytes)).toBe('Schönberg and � Müller')
  })

  it('latexToText: dotless i and j, œ, unbraced cedilla, TeX logos and math commands', () => {
    expect(latexToText(String.raw`{\i}n {\oe}uvre {\OE} \c c \v s {\LaTeX} \TeX{} $O(n \log n)$ costs 5\$`)).toBe('ın œuvre Œ ç š LaTeX TeX O(n log n) costs 5$')
  })

  it('identifiers: an arXiv DOI with a bad id, and several DOIs in one cell', () => {
    const out = parseExport('f.csv', 'title,doi\nA,10.48550/arXiv.garbage\nB,"10.1109/X.1;10.2000/y"\nC,"doi: 10.1145/1 10.1145/2"\nD,"junk, 10.1145/3"\n')!
    expect(out.records.map((r) => r.identifiers)).toEqual([{ doi: '10.48550/arxiv.garbage' }, { doi: '10.1109/x.1' }, { doi: '10.1145/1' }, { doi: '10.1145/3' }])
  })
})
