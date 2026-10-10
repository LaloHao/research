import { describe, expect, it } from 'vitest'
import { findMatches, joinTextItems, lineKey, reflowPage, repeatedLines } from '../../src/renderer/lib/reflow'

describe('reflowPage', () => {
  it('merges the lines of a paragraph into one', () => {
    expect(reflowPage('The model reads the\ninput and writes\nthe output.')).toEqual([
      { kind: 'paragraph', text: 'The model reads the input and writes the output.' }
    ])
  })

  it('joins a word hyphenated at the end of a line', () => {
    expect(reflowPage('a robust detec-\ntion method')).toEqual([{ kind: 'paragraph', text: 'a robust detection method' }])
  })

  it('keeps real hyphens that are not at a line end', () => {
    expect(reflowPage('a state-of-the-art\nmodel')).toEqual([{ kind: 'paragraph', text: 'a state-of-the-art model' }])
  })

  it('keeps the hyphen at a line end when the next line does not start with a lowercase letter', () => {
    expect(reflowPage('during the COVID-\n19 pandemic')).toEqual([{ kind: 'paragraph', text: 'during the COVID-19 pandemic' }])
  })

  it('drops a soft hyphen at a line end', () => {
    expect(reflowPage('detec\u00ad\ntion')).toEqual([{ kind: 'paragraph', text: 'detection' }])
  })

  it('collapses runs of whitespace inside a line', () => {
    expect(reflowPage('two   spaces\there')).toEqual([{ kind: 'paragraph', text: 'two spaces here' }])
  })

  it('splits paragraphs on blank lines', () => {
    expect(reflowPage('First paragraph\ncontinues.\n\n  \nSecond one.')).toEqual([
      { kind: 'paragraph', text: 'First paragraph continues.' },
      { kind: 'paragraph', text: 'Second one.' }
    ])
  })

  it('splits when a short line ends a sentence and the next starts with an uppercase letter', () => {
    const raw = [
      'This is a long line of body text that fills the column width',
      'and this one ends the paragraph.',
      'Another paragraph starts here with a long line of body text',
      'and goes on.'
    ].join('\n')
    expect(reflowPage(raw)).toEqual([
      { kind: 'paragraph', text: 'This is a long line of body text that fills the column width and this one ends the paragraph.' },
      { kind: 'paragraph', text: 'Another paragraph starts here with a long line of body text and goes on.' }
    ])
  })

  it('does not split after a full-width line that happens to end a sentence', () => {
    const raw = ['This is a long line of body text that fills the col. width.', 'Next sentence continues the paragraph here.'].join('\n')
    expect(reflowPage(raw)).toHaveLength(1)
  })

  it('detects numbered section headings', () => {
    expect(reflowPage('1 Introduction\nText of the intro.\n2.3 Results and Discussion\nMore text.')).toEqual([
      { kind: 'heading', text: '1 Introduction' },
      { kind: 'paragraph', text: 'Text of the intro.' },
      { kind: 'heading', text: '2.3 Results and Discussion' },
      { kind: 'paragraph', text: 'More text.' }
    ])
  })

  it('detects short all-caps lines and well-known unnumbered section names as headings', () => {
    expect(reflowPage('RELATED WORK\nSome text.\nAbstract\nThe abstract.')).toEqual([
      { kind: 'heading', text: 'RELATED WORK' },
      { kind: 'paragraph', text: 'Some text.' },
      { kind: 'heading', text: 'Abstract' },
      { kind: 'paragraph', text: 'The abstract.' }
    ])
  })

  it('does not take a sentence starting with a number, or a long line, as a heading', () => {
    expect(reflowPage('the score went up by\n3 points in Table 2, a large improvement.')).toEqual([
      { kind: 'paragraph', text: 'the score went up by 3 points in Table 2, a large improvement.' }
    ])
    expect(reflowPage('1 Introduction of a very long line that is clearly a sentence and not a heading at all')).toEqual([
      { kind: 'paragraph', text: '1 Introduction of a very long line that is clearly a sentence and not a heading at all' }
    ])
  })

  it('returns no blocks for an empty page', () => {
    expect(reflowPage('')).toEqual([])
    expect(reflowPage('\n  \n')).toEqual([])
  })

  it('puts repeated header and footer lines in their own margin blocks', () => {
    const repeated = new Set([lineKey('Journal of Things, 2021'), lineKey('7')])
    expect(reflowPage('Journal of Things, 2021\nBody text here\ngoes on.\n7', repeated)).toEqual([
      { kind: 'margin', text: 'Journal of Things, 2021' },
      { kind: 'paragraph', text: 'Body text here goes on.' },
      { kind: 'margin', text: '7' }
    ])
  })

  it('only treats a repeated line as margin among the first and last two lines', () => {
    const repeated = new Set([lineKey('Repeated')])
    const blocks = reflowPage('a\nb\nc\nRepeated\nd\ne\nf', repeated)
    expect(blocks.some((b) => b.kind === 'margin')).toBe(false)
  })
})

describe('lineKey', () => {
  it('ignores case, spacing and the digits themselves', () => {
    expect(lineKey('  Page 3  of 10 ')).toBe(lineKey('page 4 of 10'))
    expect(lineKey('12')).toBe(lineKey('7'))
  })
})

describe('repeatedLines', () => {
  const page = (n: number, body: string): string => `Proceedings of ACL 2021\n${body}\nand more text.\n${n}`

  it('finds headers and page numbers repeated on at least 60% of pages', () => {
    const pages = [page(1, 'One'), page(2, 'Two'), page(3, 'Three'), 'Unusual first line\nbody\n\nend line', page(5, 'Five')]
    const set = repeatedLines(pages)
    expect(set.has(lineKey('Proceedings of ACL 2021'))).toBe(true)
    expect(set.has(lineKey('4'))).toBe(true)
    expect(set.has(lineKey('One'))).toBe(false)
    expect(set.has(lineKey('Unusual first line'))).toBe(false)
  })

  it('does not count a line in the middle of a page', () => {
    const pages = ['a\nb\nShared\nc\nd', 'e\nf\nShared\ng\nh', 'i\nj\nShared\nk\nl']
    expect(repeatedLines(pages).has(lineKey('Shared'))).toBe(false)
  })

  it('needs at least two pages', () => {
    expect(repeatedLines(['Header\nbody\n1']).size).toBe(0)
  })

  it('stays below the threshold when a line repeats on fewer than 60% of pages', () => {
    const pages = ['Header\nx', 'Header\ny', 'other\nz', 'another\nw']
    expect(repeatedLines(pages).has(lineKey('Header'))).toBe(false)
    expect(repeatedLines([...pages.slice(0, 2), 'Header\nq', 'another\nw']).has(lineKey('Header'))).toBe(true)
  })

  it('counts a line once per page even if it appears twice there', () => {
    const pages = ['Same\nSame\nx', 'a\nb', 'c\nd']
    expect(repeatedLines(pages).has(lineKey('Same'))).toBe(false)
  })
})

describe('findMatches', () => {
  it('finds every occurrence, case-insensitively, in every block', () => {
    expect(findMatches(['Model and model', 'no', 'MODEL'], 'model')).toEqual([
      { block: 0, start: 0, end: 5 },
      { block: 0, start: 10, end: 15 },
      { block: 2, start: 0, end: 5 }
    ])
  })

  it('ignores diacritics on either side and maps back to the original offsets', () => {
    const text = 'La educación pública'
    const [m] = findMatches([text], 'educacion')
    expect(text.slice(m.start, m.end)).toBe('educación')
    const [n] = findMatches(['la educacion'], 'EDUCACIÓN')
    expect(n).toEqual({ block: 0, start: 3, end: 12 })
  })

  it('maps back offsets over decomposed accents and collapsed whitespace', () => {
    const text = 'una  tecnologi\u0301a   nueva'
    const [m] = findMatches([text], 'tecnología nueva')
    expect(text.slice(m.start, m.end)).toBe('tecnologi\u0301a   nueva')
  })

  it('does not return overlapping matches', () => {
    expect(findMatches(['aaaa'], 'aa')).toEqual([
      { block: 0, start: 0, end: 2 },
      { block: 0, start: 2, end: 4 }
    ])
  })

  it('returns nothing for a blank query or no match', () => {
    expect(findMatches(['text'], '   ')).toEqual([])
    expect(findMatches(['text'], 'other')).toEqual([])
  })

  it('treats typographic quotes and dashes like their plain forms', () => {
    const text = 'the “self–attention” layer'
    const [m] = findMatches([text], '"self-attention"')
    expect(text.slice(m.start, m.end)).toBe('“self–attention”')
  })
})

describe('joinTextItems', () => {
  it('joins pdf.js text items, breaking lines where an item ends one', () => {
    expect(joinTextItems([{ str: 'Hello', hasEOL: false }, { str: ' world', hasEOL: true }, { str: 'next', hasEOL: false }, {}])).toBe(
      'Hello world\nnext'
    )
  })
})
