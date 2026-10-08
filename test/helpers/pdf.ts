import { PDFDocument, StandardFonts } from 'pdf-lib'

/** A real PDF with one text line per entry; pdf.js extracts it like any paper. */
export async function makePdf(pages: string[][], info: { title?: string; author?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  if (info.title) doc.setTitle(info.title)
  if (info.author) doc.setAuthor(info.author)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = doc.addPage([595, 842])
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }))
  }
  return doc.save()
}
