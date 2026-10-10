import type { PDFDocumentProxy } from 'pdfjs-dist'
import { describe, expect, it, vi } from 'vitest'
import { runningLines } from '../../src/renderer/components/paper/pdfText'

/** A fake pdf.js document whose page `n` reads as `Header\nBody n\n`, or rejects when `failing(n)`. */
function fakeDoc(numPages: number, failing: (n: number) => boolean = () => false) {
  const getPage = vi.fn(async (n: number) => {
    if (failing(n)) throw new Error('destroyed')
    return { getTextContent: async () => ({ items: [{ str: 'Running header', hasEOL: true }, { str: `Body text of page ${n}.`, hasEOL: true }] }) }
  })
  return { doc: { fingerprints: ['fp'], numPages, getPage } as unknown as PDFDocumentProxy, getPage }
}

describe('runningLines', () => {
  it('caches the sample when every page was read', async () => {
    const first = fakeDoc(3)
    const repeated = await runningLines('all-read', first.doc)
    expect(repeated.size).toBeGreaterThan(0)
    const second = fakeDoc(3)
    expect(await runningLines('all-read', second.doc)).toBe(repeated)
    expect(second.getPage).not.toHaveBeenCalled()
  })

  it('does not cache a sample in which some page failed to read', async () => {
    await runningLines('some-failed', fakeDoc(3, (n) => n === 2).doc)
    const retry = fakeDoc(3)
    await runningLines('some-failed', retry.doc)
    expect(retry.getPage).toHaveBeenCalledTimes(3)
  })

  it('does not cache a sample in which every page failed to read', async () => {
    expect((await runningLines('all-failed', fakeDoc(2, () => true).doc)).size).toBe(0)
    const retry = fakeDoc(2)
    await runningLines('all-failed', retry.doc)
    expect(retry.getPage).toHaveBeenCalledTimes(2)
  })

  it('samples once for concurrent callers', async () => {
    const a = fakeDoc(3)
    const b = fakeDoc(3)
    const [ra, rb] = await Promise.all([runningLines('concurrent', a.doc), runningLines('concurrent', b.doc)])
    expect(rb).toBe(ra)
    expect(b.getPage).not.toHaveBeenCalled()
  })

  it('hands each sampled page to onRead', async () => {
    const read: number[] = []
    await runningLines('on-read', fakeDoc(2).doc, (n) => read.push(n))
    expect(read.sort()).toEqual([1, 2])
  })
})
