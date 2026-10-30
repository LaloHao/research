import { describe, expect, it } from 'vitest'
import type { Detection } from '../../extension/src/detect'
import { kindLabel, lookupBody, needs, planCapture } from '../../extension/src/payload'

const base: Detection = { url: 'https://journal.example.org/a/7', title: 'A study', kind: 'article', doi: null, arxiv: null, pdfUrl: null, isPdf: false, authors: [], date: null, meta: { 'og:type': ['article'] } }
const image = { url: 'https://cdn.example.org/f.png', data: 'iVBORw0KGgo=', type: 'png' as const }

describe('what a capture gathers', () => {
  it('reads images only for a plain web article, the HTML for anything but a PDF tab, the PDF when there is one', () => {
    expect(needs(base)).toEqual({ pdf: false, html: true, images: true })
    expect(needs({ ...base, kind: 'doi', doi: '10.1/x', pdfUrl: 'https://journal.example.org/a/7.pdf' })).toEqual({ pdf: true, html: true, images: false })
    expect(needs({ ...base, kind: 'pdf', isPdf: true, pdfUrl: base.url })).toEqual({ pdf: true, html: false, images: false })
  })
})

describe('planCapture', () => {
  it('sends a DOI or arXiv page without a PDF through the identifier flow', () => {
    expect(planCapture({ ...base, kind: 'doi', doi: '10.5555/jot.7' }, { html: '<html></html>', images: [], pdf: null })).toEqual({
      endpoint: 'capture_identifier',
      body: { identifier: '10.5555/jot.7', page_url: base.url, title: 'A study' }
    })
    expect(planCapture({ ...base, kind: 'arxiv', arxiv: '2401.01234', title: '' }, { html: '', images: [], pdf: null }).body).toEqual({ identifier: 'arXiv:2401.01234', page_url: base.url })
  })

  it('sends the whole page when it has a PDF, or no identifier', () => {
    const withPdf = planCapture({ ...base, kind: 'doi', doi: '10.5555/jot.7' }, { html: '<html>x</html>', images: [], pdf: 'JVBERi0=' })
    expect(withPdf).toEqual({ endpoint: 'capture_page', body: { url: base.url, title: 'A study', html: '<html>x</html>', meta: base.meta, images: [], pdf: 'JVBERi0=' } })
    const article = planCapture(base, { html: '<html>y</html>', images: [image], pdf: null })
    expect(article).toEqual({ endpoint: 'capture_page', body: { url: base.url, title: 'A study', html: '<html>y</html>', meta: base.meta, images: [image] } })
    // A PDF tab's viewer page is never sent as the paper's HTML.
    const tab = planCapture({ ...base, kind: 'pdf', isPdf: true, pdfUrl: base.url }, { html: '<embed>', images: [], pdf: 'JVBERi0=' })
    expect(tab.body).toMatchObject({ html: '', pdf: 'JVBERi0=' })
  })

  it('looks a page up by its URL and identifiers, and names what it is', () => {
    expect(lookupBody({ ...base, doi: '10.1/x' })).toEqual({ url: base.url, doi: '10.1/x' })
    expect(lookupBody(base)).toEqual({ url: base.url })
    expect(kindLabel({ ...base, kind: 'doi', doi: '10.1/x', pdfUrl: 'https://x/y.pdf' })).toBe('Artículo con DOI y PDF')
    expect(kindLabel({ ...base, kind: 'pdf' })).toBe('PDF')
    expect(kindLabel(base)).toBe('Artículo web')
  })
})
