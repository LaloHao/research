import { describe, expect, it } from 'vitest'
import { buildPaperText, pagesFromChunks, stripReferences } from '../../../src/main/summary/paperText'

const body = (n: number) => `Body text of page ${n}. `.repeat(40)

describe('pagesFromChunks', () => {
  it('groups consecutive chunks by page', () => {
    expect(
      pagesFromChunks([
        { page: 1, text: 'a' },
        { page: 1, text: 'b' },
        { page: 2, text: 'c' }
      ])
    ).toEqual([
      { page: 1, text: 'a b' },
      { page: 2, text: 'c' }
    ])
  })
})

describe('stripReferences', () => {
  it('cuts from a late References heading', () => {
    const pages = [1, 2, 3, 4].map((p) => ({ page: p, text: body(p) }))
    pages.push({ page: 5, text: `${body(5)} References [1] A. Author. Some paper. 2020.` })
    pages.push({ page: 6, text: '[2] B. Author. Another paper. 2021.' })
    const out = stripReferences(pages)
    expect(out.map((p) => p.page)).toEqual([1, 2, 3, 4, 5])
    expect(out[4].text).not.toContain('[1] A. Author')
  })

  it('keeps an early mention of the word references', () => {
    const pages = [{ page: 1, text: `References to prior work are discussed. ${body(1)}` }, { page: 2, text: body(2) }, { page: 3, text: body(3) }]
    expect(stripReferences(pages)).toEqual(pages)
  })
})

describe('buildPaperText', () => {
  const chunks = [1, 2].map((p) => ({ page: p, text: `Page ${p} content.` }))

  it('marks pages for citation', () => {
    const r = buildPaperText(chunks, { maxChars: 1000 })
    expect(r.input).toBe('[p.1]\nPage 1 content.\n\n[p.2]\nPage 2 content.')
    expect(r).toMatchObject({ tooLong: false, truncated: false })
  })

  it('leaves page-less text unmarked', () => {
    expect(buildPaperText([{ page: null, text: 'Web article.' }], { maxChars: 1000 }).input).toBe('Web article.')
  })

  it('flags too long text and truncates only when forced', () => {
    expect(buildPaperText(chunks, { maxChars: 10 })).toMatchObject({ tooLong: true, truncated: false })
    const forced = buildPaperText(chunks, { maxChars: 10, force: true })
    expect(forced).toMatchObject({ tooLong: true, truncated: true })
    expect(forced.input).toHaveLength(10)
  })
})
