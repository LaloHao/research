import { describe, expect, it } from 'vitest'
import {
  citedKeys,
  detectFormat,
  findIncludes,
  maskLatex,
  pageOf,
  parseCitations,
  resolveCitations,
  splitSentences,
  type KeyIndex
} from '../../../src/shared/writing/citations'

const keys = (text: string, format?: Parameters<typeof parseCitations>[1]): string[][] => parseCitations(text, format).map((c) => c.keys)

describe('LaTeX citations', () => {
  it('recognizes every natbib and biblatex command', () => {
    for (const cmd of ['cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'fullcite', 'nocite']) {
      const [c] = parseCitations(`Text \\${cmd}{he2017drain}.`, 'latex')
      expect(c).toMatchObject({ command: cmd, keys: ['he2017drain'], syntax: 'latex' })
    }
  })

  it('keeps the star, capitalized forms and several keys', () => {
    expect(parseCitations('\\citep*{a, b ,c}', 'latex')[0]).toMatchObject({ command: 'citep*', keys: ['a', 'b', 'c'] })
    expect(parseCitations('\\Textcite{a}', 'latex')[0].command).toBe('Textcite')
  })

  it('reads one optional argument as the postnote and two as prenote and postnote', () => {
    const [one] = parseCitations('\\cite[p.~3]{a}', 'latex')
    expect(one).toMatchObject({ locator: 'p.~3', page: '3' })
    const [two] = parseCitations('\\citep[véase][12]{a}', 'latex')
    expect(two).toMatchObject({ locator: '12', page: '12' })
    expect(two.items[0].prefix).toBe('véase')
    const [empty] = parseCitations('\\autocite[][pp.~3--5]{a}', 'latex')
    expect(empty.page).toBe('3-5')
  })

  it('reports offsets of the whole command', () => {
    const text = 'As shown \\cite[p.~3]{a,b}.'
    const [c] = parseCitations(text, 'latex')
    expect(text.slice(c.start, c.end)).toBe('\\cite[p.~3]{a,b}')
  })

  it('ignores other commands that start like a citation', () => {
    expect(keys('\\citefoo{a} \\citation{b} \\cite{c}', 'latex')).toEqual([['c']])
  })

  it('ignores comments but not an escaped percent sign', () => {
    expect(keys('% \\cite{a}\nLine \\cite{b} % \\cite{c}\n50\\% of \\cite{d}', 'latex')).toEqual([['b'], ['d']])
    // `\\%` is a line break followed by a comment.
    expect(keys('A\\\\% \\cite{a}\n\\cite{b}', 'latex')).toEqual([['b']])
  })

  it('ignores verbatim, lstlisting, minted and \\verb', () => {
    const text = [
      '\\begin{verbatim}\\cite{a}\\end{verbatim}',
      '\\begin{lstlisting}\n\\cite{b}\n\\end{lstlisting}',
      '\\begin{minted}{python}\n\\cite{c}\n\\end{minted}',
      '\\verb|\\cite{d}| and \\cite{e}'
    ].join('\n')
    expect(keys(text, 'latex')).toEqual([['e']])
  })

  it('drops \\nocite{*} and empty key lists', () => {
    expect(keys('\\nocite{*} \\cite{} \\cite{ , a}', 'latex')).toEqual([['a']])
  })

  it('keeps offsets with characters outside the BMP', () => {
    const text = '😀 % 😀\n\\cite{a}'
    const [c] = parseCitations(text, 'latex')
    expect(text.slice(c.start, c.end)).toBe('\\cite{a}')
    expect(maskLatex(text)).toHaveLength(text.length)
  })
})

describe('Markdown (pandoc) citations', () => {
  it('reads bracketed citations with prefixes and locators', () => {
    const [c] = parseCitations('Claim [see @a, p. 3; @b].', 'markdown')
    expect(c).toMatchObject({ command: 'pandoc', keys: ['a', 'b'], locator: 'p. 3', page: '3' })
    expect(c.items[0]).toMatchObject({ key: 'a', prefix: 'see', locator: 'p. 3' })
    expect(c.items[1]).toMatchObject({ key: 'b', prefix: null, locator: null })
  })

  it('reads suppressed authors and braced keys', () => {
    expect(keys('[-@a] [@{odd key}]', 'markdown')).toEqual([['a'], ['odd key']])
  })

  it('reads a bare @key, with an optional locator right after it', () => {
    const cs = parseCitations('@a says so, and @b [p. 4] agrees.', 'markdown')
    expect(cs.map((c) => [c.command, c.keys[0], c.page])).toEqual([
      ['pandoc_bare', 'a', null],
      ['pandoc_bare', 'b', '4']
    ])
  })

  it('never reads an email, a handle in a URL or a link as a citation', () => {
    expect(keys('Write to me@uni.edu or see https://x.com/@user and [a link](http://a.b).', 'markdown')).toEqual([])
    expect(keys('[mail me@uni.edu]', 'markdown')).toEqual([])
  })

  it('stops a bare key before trailing punctuation', () => {
    expect(keys('As @he2017drain.', 'markdown')).toEqual([['he2017drain']])
    expect(keys('As @doe:2020-a, then', 'markdown')).toEqual([['doe:2020-a']])
  })

  it('ignores code and HTML comments', () => {
    const text = '```\n[@a]\n```\nInline `@b` and <!-- [@c] --> and [@d].'
    expect(keys(text, 'markdown')).toEqual([['d']])
  })

  it('does not read pandoc citations in LaTeX', () => {
    expect(keys('[@a] and @b', 'latex')).toEqual([])
  })
})

describe('Org (org-cite) citations', () => {
  it('reads [cite:@key] and styles', () => {
    expect(parseCitations('Text [cite:@a].', 'org')[0]).toMatchObject({ command: 'cite', keys: ['a'], syntax: 'org' })
    expect(parseCitations('[cite/t:@a;@b]', 'org')[0]).toMatchObject({ command: 'cite/t', keys: ['a', 'b'] })
    expect(parseCitations('[cite/a/f:@a]', 'org')[0].command).toBe('cite/a/f')
  })

  it('reads prefixes, locators and global affixes', () => {
    const [c] = parseCitations('[cite:global; see @a p. 3; @b pp. 4-6; end]', 'org')
    expect(c.keys).toEqual(['a', 'b'])
    expect(c.items[0]).toMatchObject({ prefix: 'see', locator: 'p. 3', page: '3' })
    expect(c.items[1].page).toBe('4-6')
    expect(c.page).toBe('3')
  })

  it('ignores comment lines and src, example and comment blocks', () => {
    const text = '# [cite:@a]\n#+begin_src latex\n\\cite{b}\n#+end_src\n#+BEGIN_COMMENT\n[cite:@c]\n#+END_COMMENT\nText [cite:@d].'
    expect(keys(text, 'org')).toEqual([['d']])
  })

  it('reads raw LaTeX citations in Org too, but not bare @key', () => {
    expect(keys('Text \\cite{a} and @b.', 'org')).toEqual([['a']])
  })
})

describe('sentences', () => {
  it('returns the sentence that contains each citation', () => {
    const text = 'First claim \\cite{a}. Second claim, e.g. a test \\cite{b}. Third.'
    expect(parseCitations(text, 'latex').map((c) => c.sentence.text)).toEqual(['First claim \\cite{a}.', 'Second claim, e.g. a test \\cite{b}.'])
  })

  it('does not split at et al., p., i.e., initials, decimals or Spanish abbreviations', () => {
    const text = 'Smith et al. (2020) show it, i.e. 3.5 times faster (p. 4). J. Doe agrees, p. ej. en el cap. 2 y la pág. 5 [@a]. Next one.'
    const [c] = parseCitations(text, 'markdown')
    expect(c.sentence.text).toBe('J. Doe agrees, p. ej. en el cap. 2 y la pág. 5 [@a].')
    expect(splitSentences(text, 'markdown')).toHaveLength(3)
  })

  it('splits at ! and ?, closing quotes, and a capital after a period', () => {
    expect(splitSentences('Really? Yes! "Done." Then it ended.', 'markdown').map((s) => s.text)).toEqual(['Really?', 'Yes!', '"Done."', 'Then it ended.'])
  })

  it('does not split before a lowercase word', () => {
    expect(splitSentences('It costs approx. ten dollars. ok.', 'markdown')).toHaveLength(1)
  })

  it('splits at blank lines, headings, list items and LaTeX structure', () => {
    const text = '\\section{Intro}\nA claim \\cite{a}\n\nAnother \\cite{b}\n\\begin{itemize}\n\\item One \\cite{c}\n\\item Two\n\\end{itemize}'
    expect(parseCitations(text, 'latex').map((c) => c.sentence.text)).toEqual(['A claim \\cite{a}', 'Another \\cite{b}', '\\item One \\cite{c}'])
    expect(parseCitations('* Heading\nBody [cite:@a].\n- item [cite:@b]', 'org').map((c) => c.sentence.text)).toEqual(['Body [cite:@a].', '- item [cite:@b]'])
  })

  it('never splits inside a citation or at a control space or tie', () => {
    const text = 'Shown by Doe et al.\\ in \\citep[p.~3. More][]{a}. Next.'
    expect(parseCitations(text, 'latex')[0].sentence.text).toBe('Shown by Doe et al.\\ in \\citep[p.~3. More][]{a}.')
  })

  it('keeps comments out of sentences', () => {
    expect(splitSentences('One. % Two. Three.\nFour.', 'latex').map((s) => s.text)).toEqual(['One.', 'Four.'])
  })
})

describe('format detection', () => {
  it('detects each format by its marks', () => {
    expect(detectFormat('Text \\citep{a}. \\section{X}')).toBe('latex')
    expect(detectFormat('#+TITLE: Thesis\n* Intro\nText [cite:@a].')).toBe('org')
    expect(detectFormat('# Intro\nText [@a; @b].')).toBe('markdown')
    expect(detectFormat('Plain text.')).toBe('markdown')
  })
})

describe('locators', () => {
  it('extracts pages and ranges', () => {
    expect(pageOf('p.~3')).toBe('3')
    expect(pageOf('pp. 3--5')).toBe('3-5')
    expect(pageOf('págs. 10–12')).toBe('10-12')
    expect(pageOf('12')).toBe('12')
    expect(pageOf('cap. 2')).toBeNull()
    expect(pageOf(null)).toBeNull()
  })
})

describe('includes', () => {
  it('finds \\input, \\include and \\subfile outside comments, and #+INCLUDE in Org', () => {
    expect(findIncludes('\\input{ch1}\n% \\include{no}\n\\include{ch2.tex}\\subfile{parts/a}', 'latex').map((i) => [i.command, i.path])).toEqual([
      ['input', 'ch1'],
      ['include', 'ch2.tex'],
      ['subfile', 'parts/a']
    ])
    expect(findIncludes('#+INCLUDE: "ch1.org" :minlevel 2\n# #+INCLUDE: "no.org"\n#+include: ch2.org', 'org').map((i) => i.path)).toEqual(['ch1.org', 'ch2.org'])
  })
})

describe('resolution against the library', () => {
  const index: KeyIndex = {
    papers: new Map([
      ['a', { hasText: true }],
      ['b', { hasText: false }]
    ]),
    trashed: new Set(['t'])
  }

  it('flags unknown, trashed and textless keys', () => {
    const report = resolveCitations(parseCitations('One \\cite{a,b}. Two \\cite{t,x}.', 'latex'), index)
    expect(report).toMatchObject({ keys: ['a', 'b', 't', 'x'], unknown: ['x'], trashed: ['t'], noText: ['b'], duplicates: [] })
    expect(report.citations[1].states).toEqual({ t: 'trashed', x: 'unknown' })
  })

  it('flags a key repeated in one citation or in the same sentence', () => {
    const report = resolveCitations(parseCitations('One \\cite{a,a}. Two \\cite{b} and \\cite{b}. Three \\cite{a}.', 'latex'), index)
    expect(report.duplicates).toEqual(['a', 'b'])
    expect(report.citations.map((c) => c.duplicates)).toEqual([['a'], ['b'], ['b'], []])
  })

  it('lists keys once in order of appearance', () => {
    expect(citedKeys(parseCitations('[@b] [@a; @b]', 'markdown'))).toEqual(['b', 'a'])
  })
})

describe('long texts', () => {
  it('parses a chapter-sized text with thousands of citations quickly', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `Claim number ${i} holds \\cite[p.~${i + 1}]{key${i % 50}}. Another sentence here.`).join('\n')
    const started = performance.now()
    const cs = parseCitations(text, 'latex')
    expect(cs).toHaveLength(5000)
    expect(cs[4999].sentence.text).toBe('Claim number 4999 holds \\cite[p.~5000]{key49}.')
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
