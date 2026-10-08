import { describe, expect, it } from 'vitest'
import { chunkSegments } from '../../../src/main/extract/chunker'

describe('chunkSegments', () => {
  it('keeps short pages as single chunks with their page number', () => {
    const chunks = chunkSegments([
      { page: 1, text: 'First page.\n\nSecond paragraph.' },
      { page: 2, text: 'Other page.' }
    ])
    expect(chunks).toEqual([
      { index: 0, page: 1, text: 'First page. Second paragraph.' },
      { index: 1, page: 2, text: 'Other page.' }
    ])
  })

  it('splits long text under the target size and never across pages', () => {
    const para = 'word '.repeat(300).trim()
    const chunks = chunkSegments([{ page: 3, text: `${para}\n\n${para}` }], 400)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(400)
      expect(c.page).toBe(3)
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  it('supports page-less segments (web pages) and skips empty text', () => {
    expect(chunkSegments([{ page: null, text: '  \n ' }, { page: null, text: 'Body' }])).toEqual([{ index: 0, page: null, text: 'Body' }])
  })
})
