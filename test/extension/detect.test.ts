import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import {
  arxivFromUrl,
  articleImages,
  cleanDoi,
  detect,
  doiFromUrl,
  isCapturable,
  isPdfBytes,
  isPdfTab,
  readMeta,
  sniffImage,
  toBase64
} from '../../extension/src/detect'

const fixture = (path: string): string => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')
/** A whole document, as a tab has one (linkedom needs the <html> around a fragment). */
const page = (html: string) => parseHTML(html.includes('<html') ? html : `<!doctype html><html><head></head><body>${html}</body></html>`).document as unknown as Document
const JOURNAL = 'https://journal.example.org/article/7'

describe('readMeta', () => {
  it('keeps the citation, Dublin Core, PRISM and Open Graph tags, lowercased, and nothing else', () => {
    const meta = readMeta(page(fixture('extension/journal.html')))
    expect(meta.citation_author).toEqual(['Ada Lovelace', 'Alan Turing'])
    expect(meta['dc.identifier']).toEqual(['ISSN 1234-5678', 'doi:10.5555/JOT.2023.7.'])
    expect(meta['og:type']).toEqual(['article'])
    expect(meta).not.toHaveProperty('csrf-token')
    expect(meta).not.toHaveProperty('viewport')
  })
})

describe('detect', () => {
  it('reads a journal page: its DOI (not the ISSN), title, authors, date and absolute PDF link', () => {
    const d = detect(page(fixture('extension/journal.html')), JOURNAL, 'text/html')
    expect(d).toMatchObject({
      kind: 'doi',
      doi: '10.5555/jot.2023.7',
      arxiv: null,
      title: 'Log Parsing at Scale: A Study',
      authors: ['Ada Lovelace', 'Alan Turing'],
      date: '2023/05/01',
      pdfUrl: 'https://journal.example.org/content/pdf/10.5555/jot.2023.7.pdf',
      isPdf: false
    })
  })

  it('reads the app fixtures: a scholarly landing page and a plain blog post', () => {
    expect(detect(page(fixture('web/scholarly.html')), 'https://ieeexplore.ieee.test/document/1', 'text/html')).toMatchObject({ kind: 'doi', doi: '10.1109/icws.2017.13', pdfUrl: null })
    const blog = detect(page(fixture('web/postmortem.html')), 'https://eng.acme.test/posts/database-outage', 'text/html')
    expect(blog).toMatchObject({ kind: 'article', doi: null, arxiv: null, pdfUrl: null })
    expect(blog.title).toBeTruthy()
  })

  it('tells arXiv pages and PDF tabs by their address and content type', () => {
    expect(detect(page('<title>x</title>'), 'https://arxiv.org/abs/2401.01234v3', 'text/html')).toMatchObject({ kind: 'arxiv', arxiv: '2401.01234' })
    const pdf = detect(page('<embed type="application/pdf">'), 'https://files.example.org/paper', 'application/pdf')
    expect(pdf).toMatchObject({ kind: 'pdf', isPdf: true, pdfUrl: 'https://files.example.org/paper', meta: {} })
    expect(detect(page(''), 'https://arxiv.org/pdf/2401.01234', 'application/pdf')).toMatchObject({ kind: 'arxiv', isPdf: true, pdfUrl: 'https://arxiv.org/pdf/2401.01234' })
    expect(detect(page(''), 'https://doi.org/10.1000/xyz123', 'text/html')).toMatchObject({ kind: 'doi', doi: '10.1000/xyz123' })
  })

  it('ignores a citation_pdf_url that is not on the web', () => {
    const d = detect(page('<meta name="citation_pdf_url" content="javascript:alert(1)">'), JOURNAL, 'text/html')
    expect(d.pdfUrl).toBeNull()
  })
})

describe('identifiers and tabs', () => {
  it('cleans DOIs and finds them in URLs', () => {
    expect(cleanDoi('https://doi.org/10.1145/3368089.3409733).')).toBe('10.1145/3368089.3409733')
    expect(cleanDoi('ISSN 1234-5678')).toBeNull()
    expect(doiFromUrl('https://dl.acm.org/doi/10.1145/3368089.3409733')).toBe('10.1145/3368089.3409733')
    expect(arxivFromUrl('https://arxiv.org/pdf/2401.01234v2.pdf')).toBe('2401.01234')
    expect(arxivFromUrl('https://arxiv.org/abs/hep-th/9901001')).toBe('hep-th/9901001')
    expect(arxivFromUrl('https://example.org/abs/2401.01234')).toBeNull()
  })

  it('detects PDF tabs, and knows which pages it can never capture', () => {
    expect(isPdfTab('https://a.example/x.PDF', null)).toBe(true)
    expect(isPdfTab('https://a.example/x', 'application/pdf; charset=binary')).toBe(true)
    expect(isPdfTab('https://a.example/x.html', 'text/html')).toBe(false)
    expect(isPdfTab('file:///home/me/x.pdf', null)).toBe(false)
    for (const url of ['about:addons', 'chrome://settings', 'moz-extension://x/popup.html', 'https://addons.mozilla.org/x', 'https://chromewebstore.google.com/x', undefined]) {
      expect(isCapturable(url)).toBe(false)
    }
    expect(isCapturable('https://journal.example.org/')).toBe(true)
  })
})

describe('articleImages', () => {
  it('takes the article container images, resolved like the app does (lazy sources, srcset), each once and web-only', () => {
    expect(articleImages(page(fixture('extension/journal.html')), JOURNAL)).toEqual([
      'https://journal.example.org/article/figures/fig1.png',
      'https://cdn.example.org/fig2.jpg',
      'https://cdn.example.org/fig3-1x.webp'
    ])
  })

  it('falls back to the whole body and stops at 40', () => {
    const imgs = Array.from({ length: 50 }, (_, i) => `<img src="/i${i}.png">`).join('')
    expect(articleImages(page(`<div>${imgs}</div>`), JOURNAL)).toHaveLength(40)
  })
})

describe('bytes', () => {
  it('sniffs raster images and PDFs, and encodes large buffers', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png')
    expect(sniffImage(new TextEncoder().encode('<svg/>'))).toBeNull()
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(isPdfBytes(new TextEncoder().encode('<html>'))).toBe(false)
    const big = new Uint8Array(200_000).map((_, i) => i % 251)
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'))
  })
})
