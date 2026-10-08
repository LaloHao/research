export interface TextSegment {
  /** 1-based PDF page, or null for page-less text such as a captured web page. */
  page: number | null
  text: string
}

export interface Chunk {
  index: number
  page: number | null
  text: string
}

const DEFAULT_TARGET = 1200

/** Paragraph-aware chunks that never span two pages, so every chunk cites one page. */
export function chunkSegments(segments: TextSegment[], targetChars = DEFAULT_TARGET): Chunk[] {
  const chunks: Chunk[] = []
  for (const segment of segments) {
    const paragraphs = segment.text
      .split(/\n\s*\n|(?<=[.!?])\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    let buffer = ''
    const flush = (): void => {
      if (buffer) chunks.push({ index: chunks.length, page: segment.page, text: buffer })
      buffer = ''
    }
    for (const paragraph of paragraphs) {
      for (const piece of splitLong(paragraph, targetChars)) {
        if (buffer && buffer.length + 1 + piece.length > targetChars) flush()
        buffer = buffer ? `${buffer} ${piece}` : piece
      }
    }
    flush()
  }
  return chunks
}

function splitLong(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}
