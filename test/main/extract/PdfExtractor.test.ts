import { describe, expect, it } from 'vitest'
import { isTextless, PdfjsExtractor } from '../../../src/main/extract/PdfExtractor'
import { makePdf } from '../../helpers/pdf'

describe('PdfjsExtractor', () => {
  it('extracts text per page and the document info', async () => {
    const bytes = await makePdf(
      [['Sanitizing logs with NER', 'We study PII in production logs.', 'DOI: 10.1109/ICWS.2017.13'], ['Pseudonymization keeps referential integrity.']],
      { title: 'Sanitizing logs with NER', author: 'Ana Pérez' }
    )
    const text = await new PdfjsExtractor().extract(bytes)
    expect(text.pages.map((p) => p.page)).toEqual([1, 2])
    expect(text.pages[0].text).toContain('DOI: 10.1109/ICWS.2017.13')
    expect(text.pages[1].text).toContain('referential integrity')
    expect(text.info).toEqual({ title: 'Sanitizing logs with NER', author: 'Ana Pérez' })
    expect(isTextless(text)).toBe(false)
  })

  it('does not detach the caller buffer', async () => {
    const bytes = await makePdf([['hello']])
    const size = bytes.byteLength
    await new PdfjsExtractor().extract(bytes)
    expect(bytes.byteLength).toBe(size)
  })

  it('flags scanned-like PDFs with no text', async () => {
    const text = await new PdfjsExtractor().extract(await makePdf([[]]))
    expect(isTextless(text)).toBe(true)
  })
})
