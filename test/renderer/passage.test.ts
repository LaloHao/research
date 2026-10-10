import { describe, expect, it } from 'vitest'
import { blockSegments, paragraphSegments } from '../../src/renderer/lib/passage'

describe('paragraphSegments', () => {
  it('returns one paragraph, unmarked, when there is no match', () => {
    const segments = paragraphSegments('Hello world.', null)
    expect(segments).toEqual([[{ text: 'Hello world.', marked: false }]])
  })

  it('splits on a blank line into separate paragraphs', () => {
    const segments = paragraphSegments('First paragraph.\n\nSecond paragraph.', null)
    expect(segments).toEqual([[{ text: 'First paragraph.', marked: false }], [{ text: 'Second paragraph.', marked: false }]])
  })

  it('keeps a single line break inside one paragraph', () => {
    const segments = paragraphSegments('Line one.\nLine two.', null)
    expect(segments).toEqual([[{ text: 'Line one.\nLine two.', marked: false }]])
  })

  it('marks the matched range inside a single paragraph', () => {
    const text = 'We fine-tune a BERT model on logs.'
    const match = { start: text.indexOf('BERT'), end: text.indexOf('BERT') + 'BERT'.length }
    const segments = paragraphSegments(text, match)
    expect(segments).toEqual([
      [
        { text: 'We fine-tune a ', marked: false },
        { text: 'BERT', marked: true },
        { text: ' model on logs.', marked: false },
      ],
    ])
  })

  it('marks a match that starts at the beginning of a paragraph', () => {
    const text = 'BERT works well.'
    const match = { start: 0, end: 4 }
    expect(paragraphSegments(text, match)).toEqual([[{ text: 'BERT', marked: true }, { text: ' works well.', marked: false }]])
  })

  it('marks a match that runs to the end of a paragraph', () => {
    const text = 'We used a BERT'
    const match = { start: text.indexOf('BERT'), end: text.length }
    expect(paragraphSegments(text, match)).toEqual([[{ text: 'We used a ', marked: false }, { text: 'BERT', marked: true }]])
  })

  it('marks each part of a match that spans a paragraph break', () => {
    const text = 'We fine-tune a BERT\n\nmodel on 12k log lines.'
    const match = { start: text.indexOf('BERT'), end: text.indexOf('log lines') + 'log lines'.length }
    const segments = paragraphSegments(text, match)
    expect(segments).toEqual([
      [
        { text: 'We fine-tune a ', marked: false },
        { text: 'BERT', marked: true },
      ],
      [
        { text: 'model on 12k log lines', marked: true },
        { text: '.', marked: false },
      ],
    ])
  })

  it('trims leading and trailing blank lines, adjusting the match offsets', () => {
    const text = '\n\nFirst.\n\nSecond.\n\n'
    const match = { start: text.indexOf('Second'), end: text.indexOf('Second') + 'Second'.length }
    const segments = paragraphSegments(text, match)
    expect(segments).toEqual([
      [{ text: 'First.', marked: false }],
      [
        { text: 'Second', marked: true },
        { text: '.', marked: false },
      ],
    ])
  })

  it('treats \\r\\n\\r\\n as a paragraph break', () => {
    const segments = paragraphSegments('First.\r\n\r\nSecond.', null)
    expect(segments).toEqual([[{ text: 'First.', marked: false }], [{ text: 'Second.', marked: false }]])
  })

  it('returns a single empty paragraph for an empty passage', () => {
    expect(paragraphSegments('', null)).toEqual([[{ text: '', marked: false }]])
  })
})

describe('blockSegments', () => {
  it('returns every block unmarked when the quote is not found', () => {
    expect(blockSegments(['Intro', 'Body text here.'], 'nowhere to be seen at all')).toEqual([
      [{ text: 'Intro', marked: false }],
      [{ text: 'Body text here.', marked: false }],
    ])
  })

  it('returns every block unmarked when the quote is empty', () => {
    expect(blockSegments(['Some text.'], '')).toEqual([[{ text: 'Some text.', marked: false }]])
  })

  it('marks the quote inside the block that contains it', () => {
    expect(blockSegments(['Methods', 'We fine-tune a BERT model on logs.'], 'a BERT model')).toEqual([
      [{ text: 'Methods', marked: false }],
      [
        { text: 'We fine-tune ', marked: false },
        { text: 'a BERT model', marked: true },
        { text: ' on logs.', marked: false },
      ],
    ])
  })

  it('marks a quote that spans two blocks in both of them', () => {
    expect(blockSegments(['The first ends here.', 'The second starts there.'], 'ends here. The second')).toEqual([
      [
        { text: 'The first ', marked: false },
        { text: 'ends here.', marked: true },
      ],
      [
        { text: 'The second', marked: true },
        { text: ' starts there.', marked: false },
      ],
    ])
  })

  it('tolerates case and spacing differences in the quote', () => {
    const segments = blockSegments(['Results show   gains.'], 'results SHOW gains')
    expect(segments[0].filter((s) => s.marked).map((s) => s.text)).toEqual(['Results show   gains'])
  })

  it('returns no blocks for no blocks', () => {
    expect(blockSegments([], 'anything')).toEqual([])
  })
})
