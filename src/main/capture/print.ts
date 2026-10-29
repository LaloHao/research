import { BrowserWindow, session, type Session } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readArticle } from '../ingest/web'
import { hardenSession, READER_PARTITION, readerWindowOptions } from './policy'
import { buildReaderHtml, embedImages, sanitizeArticle, type ImageFetcher } from './reader'

/** Longest a reader print may take (loading the document and printing it). */
const PRINT_TIMEOUT_MS = 60_000
const IMAGE_TIMEOUT_MS = 15_000

/** Page numbers at the foot of each page; no header (Chromium's default would print the date and file path). */
const FOOTER = '<div style="width:100%;text-align:center;font-size:8pt;color:#555;font-family:serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'

/** An image fetcher through the page's own session (its cookies and any check the user passed), capped in size. */
export function sessionImageFetcher(source: Session, referrer: string): ImageFetcher {
  return async (url, maxBytes) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
    try {
      const res = await source.fetch(url, { headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' }, referrer, signal: controller.signal })
      if (!res.ok || !res.body) return null
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return null
      const reader = res.body.getReader()
      const parts: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return null
        }
        parts.push(value)
      }
      return new Uint8Array(Buffer.concat(parts))
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The reader-view PDF of a captured page: its article sanitized, images fetched through `pageSession` and embedded,
 * the document written to a private temporary folder and printed in a hidden window without JavaScript whose session
 * refuses every request but that one file. Null when the page has no article.
 */
export async function printReaderPdf(html: string, url: string, pageSession: Session, now = new Date()): Promise<Uint8Array | null> {
  const article = readArticle(html, url)
  if (!article) return null
  const content = await embedImages(sanitizeArticle(article.content, url), url, sessionImageFetcher(pageSession, url))
  const document = buildReaderHtml(article, content, { url, accessed: now })
  const dir = await mkdtemp(join(tmpdir(), 'research-reader-'))
  const file = join(dir, 'reader.html')
  const fileUrl = pathToFileURL(file).href
  const readerSession = session.fromPartition(READER_PARTITION)
  hardenSession(readerSession)
  readerSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url === fileUrl || details.url.startsWith('data:')) }))
  const win = new BrowserWindow(readerWindowOptions())
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let timer: NodeJS.Timeout | undefined
  try {
    await writeFile(file, document, { encoding: 'utf8', mode: 0o600 })
    const print = (async () => {
      await win.loadURL(fileUrl)
      return win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: false,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: FOOTER,
        margins: { top: 0.75, bottom: 0.75, left: 0.8, right: 0.8 },
        generateDocumentOutline: true,
        generateTaggedPDF: true
      })
    })()
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Reader print timed out')), PRINT_TIMEOUT_MS)))
    return new Uint8Array(await Promise.race([print, timeout]))
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
