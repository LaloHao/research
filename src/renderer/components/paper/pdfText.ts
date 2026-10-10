import type { PDFDocumentProxy } from 'pdfjs-dist'
import { joinTextItems, repeatedLines } from '../../lib/reflow'

/** Pages sampled (from the start) to find running headers and footers. */
const SAMPLE_PAGES = 10

/**
 * Running header/footer samples per PDF (paper id + pdf.js fingerprint), so reopening a PDF skips
 * the sampling. Kept as promises so concurrent callers share one sampling; a sample in which any
 * page failed to read (e.g. the document was destroyed mid-way) is dropped instead of kept.
 */
const repeatedCache = new Map<string, Promise<Set<string>>>()

/** A page's raw text, its lines joined the same way the indexer does. */
export async function readPageText(doc: PDFDocumentProxy, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent()
  return joinTextItems(content.items as Array<{ str?: string; hasEOL?: boolean }>)
}

/** Samples the first pages' text; `complete` is false when any of them failed to read. */
async function sampleRepeated(doc: PDFDocumentProxy, onRead?: (page: number, text: string) => void): Promise<{ repeated: Set<string>; complete: boolean }> {
  const sample = await Promise.allSettled(Array.from({ length: Math.min(SAMPLE_PAGES, doc.numPages) }, (_, i) => readPageText(doc, i + 1)))
  const read: string[] = []
  sample.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    read.push(r.value)
    onRead?.(i + 1, r.value)
  })
  return { repeated: repeatedLines(read), complete: read.length === sample.length }
}

/**
 * The running header/footer lines of paper `id`'s open PDF (see {@link repeatedLines}), sampled
 * from its first pages and cached per document. Each sampled page's text is handed to `onRead`
 * (only when this call does the sampling) so the caller can keep it; a page that fails to read is
 * left out of the sample, and such a partial sample is returned but not cached.
 */
export async function runningLines(id: string, doc: PDFDocumentProxy, onRead?: (page: number, text: string) => void): Promise<Set<string>> {
  const key = `${id}:${doc.fingerprints[0]}`
  const cached = repeatedCache.get(key)
  if (cached) return cached
  const sampling = sampleRepeated(doc, onRead)
  const repeated = sampling.then((r) => r.repeated)
  repeatedCache.set(key, repeated)
  const drop = (): void => {
    if (repeatedCache.get(key) === repeated) repeatedCache.delete(key)
  }
  sampling.then((r) => {
    if (!r.complete) drop()
  }, drop)
  return repeated
}
