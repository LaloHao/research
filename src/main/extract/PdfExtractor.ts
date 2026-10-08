export interface ExtractedPage {
  page: number
  text: string
}

export interface PdfText {
  pages: ExtractedPage[]
  info: { title?: string; author?: string }
}

export interface PdfExtractor {
  extract(data: Uint8Array): Promise<PdfText>
}

const MIN_TEXT_CHARS = 50

export function isTextless(text: PdfText): boolean {
  return text.pages.reduce((n, p) => n + p.text.trim().length, 0) < MIN_TEXT_CHARS
}

export class PdfjsExtractor implements PdfExtractor {
  async extract(data: Uint8Array): Promise<PdfText> {
    // pdfjs-dist is ESM-only; the main bundle is CommonJS, so it is loaded with a dynamic import.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    // pdf.js transfers (detaches) the buffer it receives: hand it a copy.
    const doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, verbosity: 0 } as any).promise
    try {
      const info = (await doc.getMetadata()).info as { Title?: string; Author?: string }
      const pages: ExtractedPage[] = []
      for (let n = 1; n <= doc.numPages; n++) {
        const content = await (await doc.getPage(n)).getTextContent()
        const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('')
        pages.push({ page: n, text })
      }
      return { pages, info: { title: info?.Title?.trim() || undefined, author: info?.Author?.trim() || undefined } }
    } finally {
      await doc.destroy()
    }
  }
}
